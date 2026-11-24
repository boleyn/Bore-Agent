package browser

import (
	"context"
	"encoding/json"
)

// fillForm reuses normal fill semantics and stops at the first failed field.
// Earlier writes may already be visible, so callers receive their results.
func fillForm(ctx context.Context, fields []FormField, run func(context.Context, Action) (json.RawMessage, error)) (json.RawMessage, error) {
	type fieldResult struct {
		Ref     string `json:"ref"`
		Applied bool   `json:"applied"`
		Error   string `json:"error,omitempty"`
	}
	results := make([]fieldResult, 0, len(fields))
	for _, field := range fields {
		result := fieldResult{Ref: field.Ref}
		raw, err := run(ctx, Action{Name: "fill", Ref: field.Ref, Text: field.Text})
		if err != nil {
			result.Error = err.Error()
		} else if json.Unmarshal(raw, &result) != nil {
			result.Error = "browser_outcome_unknown"
		}
		results = append(results, result)
		if !result.Applied || result.Error != "" {
			break
		}
	}
	return json.Marshal(map[string]any{"fields": results})
}
