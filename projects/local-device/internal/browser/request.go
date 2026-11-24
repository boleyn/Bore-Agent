package browser

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
)

const maxSafeInteger = 1<<53 - 1

var requestIdentifier = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type Request struct {
	OperationID  string
	GrantID      string
	GrantVersion int64
	Deadline     int64
	Action       Action
}

// DecodeRequest validates the wire envelope and action. The session handler must
// separately verify the bound browser grant, its lease, and the deadline.
func DecodeRequest(data []byte) (Request, error) {
	var wire struct {
		OperationID  string          `json:"operationId"`
		GrantID      string          `json:"grantId"`
		GrantVersion int64           `json:"grantVersion"`
		Deadline     int64           `json:"deadline"`
		Action       json.RawMessage `json:"browserAction"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&wire) != nil || decoder.Decode(new(any)) != io.EOF ||
		!requestIdentifier.MatchString(wire.OperationID) || !requestIdentifier.MatchString(wire.GrantID) ||
		wire.GrantVersion <= 0 || wire.GrantVersion > maxSafeInteger ||
		wire.Deadline <= 0 || wire.Deadline > maxSafeInteger {
		return Request{}, errors.New("invalid_browser_request")
	}
	action, err := DecodeAction(wire.Action)
	if err != nil {
		return Request{}, err
	}
	return Request{
		OperationID: wire.OperationID, GrantID: wire.GrantID,
		GrantVersion: wire.GrantVersion, Deadline: wire.Deadline, Action: action,
	}, nil
}
