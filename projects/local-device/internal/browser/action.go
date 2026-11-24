// Package browser defines the connector's browser operations.
package browser

import (
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
)

var elementReference = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// maxActionBytes bounds one model-supplied action, including batch steps and scripts.
const maxActionBytes = 64 * 1024

// actionNames lists the embedded browser engine actions. Detailed parameter
// validation lives in the FastGPT Zod schema and the Electron engine.
var actionNames = map[string]bool{
	"navigate": true, "go_back": true, "go_forward": true, "reload": true, "snapshot": true,
	"click": true, "hover": true, "type": true, "fill": true, "select_option": true, "check": true,
	"press": true, "scroll": true, "drag": true, "upload_file": true, "fill_form": true,
	"wait_for": true, "network": true, "trace": true, "extract": true, "evaluate": true, "screenshot": true, "tabs": true,
	"dialog": true, "batch": true,
}

type FormField struct {
	Ref  string `json:"ref"`
	Text string `json:"text"`
}

// Action carries the raw validated payload for the embedded engine. The legacy
// fields are decoded leniently for the shared-tab extension and external Chrome
// fallback, which only understand the original subset of actions.
type Action struct {
	Raw    json.RawMessage
	Fields []FormField
	Name   string
	URL    string
	Ref    string
	Text   string
	Key    string
	DeltaY int
	Offset int
}

// DecodeAction checks the envelope of a device-side action before it reaches a
// driver: a JSON object no larger than 64 KiB with a known action name, HTTP(S)
// navigation targets, and a flat batch of at most 20 steps.
func DecodeAction(data []byte) (Action, error) {
	invalid := errors.New("invalid_browser_action")
	var action Action
	if len(data) > maxActionBytes {
		return action, invalid
	}
	var head struct {
		Action  string            `json:"action"`
		URL     *string           `json:"url"`
		Actions []json.RawMessage `json:"actions"`
	}
	if json.Unmarshal(data, &head) != nil || !actionNames[head.Action] {
		return action, invalid
	}
	if head.Action == "navigate" && (head.URL == nil || !validNavigation(*head.URL)) {
		return action, invalid
	}
	if head.Action == "batch" {
		if len(head.Actions) == 0 || len(head.Actions) > 20 {
			return action, invalid
		}
		for _, step := range head.Actions {
			inner, err := DecodeAction(step)
			if err != nil || inner.Name == "batch" {
				return action, invalid
			}
		}
	}
	var legacy struct {
		URL    string      `json:"url"`
		Ref    string      `json:"ref"`
		Text   string      `json:"text"`
		Key    string      `json:"key"`
		DeltaY float64     `json:"deltaY"`
		Offset float64     `json:"offset"`
		Fields []FormField `json:"fields"`
	}
	_ = json.Unmarshal(data, &legacy)
	if legacy.Ref != "" && !elementReference.MatchString(legacy.Ref) {
		return action, invalid
	}
	action = Action{
		Raw: append(json.RawMessage(nil), data...), Name: head.Action, URL: legacy.URL, Ref: legacy.Ref,
		Text: legacy.Text, Key: legacy.Key, DeltaY: int(legacy.DeltaY), Offset: int(legacy.Offset), Fields: legacy.Fields,
	}
	return action, nil
}

func validNavigation(raw string) bool {
	if len(raw) > 2048 {
		return false
	}
	target, err := url.Parse(raw)
	return err == nil && target.Hostname() != "" && target.User == nil &&
		(target.Scheme == "http" || target.Scheme == "https")
}
