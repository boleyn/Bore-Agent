package desktop

import "context"

// Management requests carry no authorization data. Buffer one request so a second
// Windows launch during startup is remembered without opening duplicate windows.
var managementRequests = make(chan struct{}, 1)

type managementSnapshot struct {
	Status   string       `json:"status"`
	Accounts []accountRow `json:"accounts"`
	Error    string       `json:"error,omitempty"`
	Address  string       `json:"address,omitempty"`
	State    string       `json:"state,omitempty"`
	Detail   string       `json:"detail,omitempty"`
}

type managementSnapshotRequest struct {
	ctx    context.Context
	reply  chan managementSnapshot
	action string
}

var managementSnapshotRequests = make(chan managementSnapshotRequest)

// RequestManagement opens or activates the management window through the tray
// controller. It never approves a grant or starts another connector instance.
func RequestManagement() {
	select {
	case managementRequests <- struct{}{}:
	default:
	}
}
