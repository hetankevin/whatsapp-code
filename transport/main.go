package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

var outputMu sync.Mutex

func emit(v any)      { outputMu.Lock(); defer outputMu.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(v) }
func fatal(err error) { emit(map[string]any{"event": "fatal", "error": err.Error()}); os.Exit(1) }
func known(jid types.JID) bool {
	return jid == types.NewMetaAIJID || jid == types.MuseJID || jid == types.MetaAIJID
}

func main() {
	syscall.Umask(0077)
	ctx := context.Background()
	state := os.Getenv("WA_STATE_DIR")
	if state == "" {
		fatal(fmt.Errorf("WA_STATE_DIR required"))
	}
	if err := os.MkdirAll(state, 0700); err != nil {
		fatal(err)
	}
	db, err := sqlstore.New(ctx, "sqlite3", "file:"+filepath.Join(state, "whatsapp.db")+"?_foreign_keys=on", waLog.Noop)
	if err != nil {
		fatal(err)
	}
	defer db.Close()
	device, err := db.GetFirstDevice(ctx)
	if err != nil {
		fatal(err)
	}
	cli := whatsmeow.NewClient(device, waLog.Noop)
	store.SetOSInfo("whatsapp-code", [3]uint32{0, 1, 0})
	cli.ManualHistorySyncDownload = true
	var selected types.JID
	var selectedMu sync.RWMutex
	cli.AddEventHandler(func(evt any) {
		switch v := evt.(type) {
		case *events.Connected:
			go func() {
				c, cancel := context.WithTimeout(ctx, 25*time.Second)
				defer cancel()
				bots, err := cli.GetBotListV2(c)
				choices := []string{}
				chosen := types.EmptyJID
				if err == nil {
					for _, b := range bots {
						if known(b.BotJID) {
							choices = append(choices, b.BotJID.String())
							if chosen.IsEmpty() || b.BotJID == types.MuseJID {
								chosen = b.BotJID
							}
						}
					}
				}
				if override := os.Getenv("WA_BOT_JID"); override != "" {
					j, e := types.ParseJID(override)
					if e != nil || !known(j) {
						emit(map[string]any{"event": "error", "error": "WA_BOT_JID must be a known Meta AI address"})
						return
					}
					chosen = j
				}
				if chosen.IsEmpty() {
					emit(map[string]any{"event": "error", "error": "No supported Meta AI bot discovered. Set WA_BOT_JID explicitly after checking the account.", "bots": choices})
					return
				}
				selectedMu.Lock()
				selected = chosen
				selectedMu.Unlock()
				emit(map[string]any{"event": "ready", "bot": chosen.String(), "bots": choices})
			}()
		case *events.Disconnected:
			selectedMu.Lock()
			selected = types.EmptyJID
			selectedMu.Unlock()
			emit(map[string]any{"event": "disconnected"})
		case *events.LoggedOut:
			selectedMu.Lock()
			selected = types.EmptyJID
			selectedMu.Unlock()
			emit(map[string]any{"event": "logged_out"})
		case *events.Message:
			selectedMu.RLock()
			bot := selected
			selectedMu.RUnlock()
			if bot.IsEmpty() || v.Info.IsFromMe || v.Info.Sender.ToNonAD() != bot || v.Info.IsGroup {
				return
			}
			data, e := protojson.Marshal(v.Message)
			if e != nil {
				return
			}
			emit(map[string]any{"event": "message", "id": v.Info.ID, "target": v.Info.MsgMetaInfo.TargetID, "edit": v.Info.MsgBotInfo.EditType, "edit_target": v.Info.MsgBotInfo.EditTargetID, "message": json.RawMessage(data)})
		}
	})
	if cli.Store.ID == nil {
		qr, err := cli.GetQRChannel(ctx)
		if err != nil {
			fatal(err)
		}
		if err := cli.Connect(); err != nil {
			fatal(err)
		}
		go func() {
			for item := range qr {
				detail := ""
				if item.Error != nil {
					detail = item.Error.Error()
				}
				emit(map[string]any{"event": "pairing", "status": item.Event, "code": item.Code, "error": detail})
			}
		}()
	} else if err := cli.Connect(); err != nil {
		fatal(err)
	}
	defer cli.Disconnect()
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		var cmd struct {
			ID     string `json:"id"`
			Prompt string `json:"prompt"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &cmd); err != nil {
			emit(map[string]any{"event": "error", "error": "Invalid command JSON"})
			continue
		}
		selectedMu.RLock()
		bot := selected
		selectedMu.RUnlock()
		if bot.IsEmpty() || !cli.IsConnected() || !cli.IsLoggedIn() {
			emit(map[string]any{"event": "error", "id": cmd.ID, "error": "WhatsApp is not ready"})
			continue
		}
		if cmd.ID == "" || strings.TrimSpace(cmd.Prompt) == "" || len(cmd.Prompt) > 240000 {
			emit(map[string]any{"event": "error", "id": cmd.ID, "error": "Invalid send request"})
			continue
		}
		c, cancel := context.WithTimeout(ctx, 40*time.Second)
		_, err := cli.SendMessage(c, bot, &waE2E.Message{Conversation: proto.String(cmd.Prompt)}, whatsmeow.SendRequestExtra{ID: cmd.ID})
		cancel()
		if err != nil {
			emit(map[string]any{"event": "error", "id": cmd.ID, "error": err.Error()})
		} else {
			emit(map[string]any{"event": "sent", "id": cmd.ID})
		}
	}
	if err := scanner.Err(); err != nil {
		fatal(err)
	}
}
