package browser

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDecodeAction(t *testing.T) {
	valid := []string{
		`{"action":"navigate","url":"https://example.com/a?b=1","snapshot":true}`,
		`{"action":"snapshot","interactive":true,"maxChars":8000}`,
		`{"action":"select_option","ref":"e12","values":["江苏","南京"]}`,
		`{"action":"fill_form","fields":[{"ref":"e1","value":"abc"},{"ref":"e2","value":true},{"ref":"e3","value":["a","b"]}]}`,
		`{"action":"evaluate","script":"document.title"}`,
		`{"action":"batch","actions":[{"action":"fill","ref":"e1","text":"hi"},{"action":"press","key":"Enter"}]}`,
		`{"action":"tabs","op":"select","index":1}`,
		`{"action":"dialog","accept":true,"promptText":"ok"}`,
	}
	for _, raw := range valid {
		act, err := DecodeAction([]byte(raw))
		if err != nil {
			t.Fatalf("expected valid %s, got %v", raw, err)
		}
		if !json.Valid(act.Raw) {
			t.Fatalf("expected Raw json for %s", raw)
		}
	}

	invalid := []string{
		`{"action":"unknown"}`,
		`{"action":"navigate","url":"file:///etc/passwd"}`,
		`{"action":"navigate","url":"https://user:pass@example.com"}`,
		`{"action":"batch","actions":[]}`,
		`{"action":"batch","actions":[{"action":"batch","actions":[{"action":"reload"}]}]}`,
		`{"action":"click","ref":"bad ref!"}`,
		`{"action":"evaluate","script":"` + strings.Repeat("a", maxActionBytes) + `"}`,
	}
	for _, raw := range invalid {
		if _, err := DecodeAction([]byte(raw)); err == nil {
			t.Fatalf("expected invalid %s", raw)
		}
	}
}
