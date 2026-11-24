package browser

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync/atomic"
)

const maxCDPMessage = 16 * 1024 * 1024

type cdpReply struct {
	ManagementAction *string         `json:"managementAction"`
	ID               uint64          `json:"id"`
	Result           json.RawMessage `json:"result"`
	Error            json.RawMessage `json:"error"`
}

// cdpPipe serves one command at a time over Chromium's NUL-delimited pipe.
// A cancelled command may still produce a reply, so calls match by ID.
type cdpPipe struct {
	ctx        context.Context
	stop       context.CancelFunc
	outbound   chan []byte
	replies    chan cdpReply
	management chan string
	slot       chan struct{}
	nextID     atomic.Uint64
}

func newCDPPipe(parent context.Context, fromBrowser io.ReadCloser, toBrowser io.WriteCloser) *cdpPipe {
	ctx, stop := context.WithCancel(parent)
	pipe := &cdpPipe{
		ctx: ctx, stop: stop, outbound: make(chan []byte),
		replies: make(chan cdpReply, 1), slot: make(chan struct{}, 1), management: make(chan string, 4),
	}
	context.AfterFunc(ctx, func() {
		_ = fromBrowser.Close()
		_ = toBrowser.Close()
	})
	go pipe.read(fromBrowser)
	go pipe.write(toBrowser)
	return pipe
}

func (p *cdpPipe) read(source io.Reader) {
	defer p.stop()
	buffer := bufio.NewReader(source)
	var message []byte
	for {
		part, err := buffer.ReadSlice(0)
		if len(message)+len(part) > maxCDPMessage {
			return
		}
		message = append(message, part...)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			return
		}
		var reply cdpReply
		if json.Unmarshal(message[:len(message)-1], &reply) != nil {
			return
		}
		message = message[:0]
		if reply.ID == 0 {
			if reply.ManagementAction != nil && len(*reply.ManagementAction) <= 2048 {
				select {
				case p.management <- *reply.ManagementAction:
				case <-p.ctx.Done():
					return
				}
			}
			continue
		}
		select {
		case p.replies <- reply:
		case <-p.ctx.Done():
			return
		}
	}
}

func (p *cdpPipe) write(destination io.Writer) {
	defer p.stop()
	for {
		select {
		case <-p.ctx.Done():
			return
		case request := <-p.outbound:
			if n, err := destination.Write(request); err != nil || n != len(request) {
				return
			}
		}
	}
}

func (p *cdpPipe) call(ctx context.Context, sessionID, method string, params any) (json.RawMessage, error) {
	select {
	case p.slot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-p.ctx.Done():
		return nil, p.ctx.Err()
	}
	defer func() { <-p.slot }()
	id := p.nextID.Add(1)
	request, err := json.Marshal(struct {
		ID        uint64 `json:"id"`
		SessionID string `json:"sessionId,omitempty"`
		Method    string `json:"method"`
		Params    any    `json:"params,omitempty"`
	}{id, sessionID, method, params})
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case p.outbound <- append(request, 0):
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-p.ctx.Done():
		return nil, p.ctx.Err()
	}
	for {
		select {
		case reply := <-p.replies:
			if reply.ID != id {
				continue
			}
			if len(reply.Error) > 0 {
				var failure struct{ Message string }
				if json.Unmarshal(reply.Error, &failure) == nil && (failure.Message == "browser_paused" || failure.Message == "browser_busy") {
					return nil, errors.New(failure.Message)
				}
				return nil, errors.New("browser_cdp_command_failed")
			}
			return reply.Result, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-p.ctx.Done():
			return nil, p.ctx.Err()
		}
	}
}
