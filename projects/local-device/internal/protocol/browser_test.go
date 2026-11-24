package protocol

import "testing"

func TestBrowserStartFrame(t *testing.T) {
	const request = `"browserRequest":{"operationId":"op","grantId":"grant","grantVersion":1,"deadline":123,"browserAction":{"action":"snapshot"}}`
	tests := []struct {
		name  string
		body  string
		valid bool
	}{
		{"browser request", `"type":"browser_start","requestId":"req","operationId":"op",` + request, true},
		{"mismatched operation", `"type":"browser_start","requestId":"req","operationId":"other",` + request, false},
		{"missing browser request", `"type":"browser_start","requestId":"req","operationId":"op"`, false},
		{"shell frame", `"type":"exec_cancel","requestId":"req","operationId":"op",` + request, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Decode([]byte(`{"version":1,"epoch":"epoch",` + tt.body + `}`))
			if (err == nil) != tt.valid {
				t.Fatalf("Decode error = %v, want valid = %t", err, tt.valid)
			}
		})
	}
}
