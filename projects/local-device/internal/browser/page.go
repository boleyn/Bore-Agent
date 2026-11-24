package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

type page struct {
	command          func(context.Context, string, any) (json.RawMessage, error)
	refs             map[string]int64
	snapshotVersion  uint64
	documentVersion  func(context.Context) (uint64, error)
	snapshotDocument uint64
}

// openPage creates and attaches to one connector-owned target.
func openPage(ctx context.Context, pipe *cdpPipe) (*page, error) {
	result, err := pipe.call(ctx, "", "Target.createTarget", map[string]string{"url": "about:blank"})
	if err != nil {
		return nil, err
	}
	var target struct {
		ID string `json:"targetId"`
	}
	if json.Unmarshal(result, &target) != nil || target.ID == "" {
		return nil, errors.New("browser_target_unavailable")
	}
	result, err = pipe.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": target.ID, "flatten": true})
	if err != nil {
		return nil, err
	}
	var session struct {
		ID string `json:"sessionId"`
	}
	if json.Unmarshal(result, &session) != nil || session.ID == "" {
		return nil, errors.New("browser_target_unavailable")
	}
	// Show the target the agent will navigate so the user can watch or take over.
	if _, err := pipe.call(ctx, "", "Target.activateTarget", map[string]string{"targetId": target.ID}); err != nil {
		return nil, err
	}
	return &page{command: func(ctx context.Context, method string, params any) (json.RawMessage, error) {
		return pipe.call(ctx, session.ID, method, params)
	}}, nil
}

// run translates validated browser actions into CDP commands on the owned page.
func (p *page) run(ctx context.Context, action Action) (json.RawMessage, error) {
	switch action.Name {
	case "navigate":
		p.refs = nil
		result, err := p.command(ctx, "Page.navigate", map[string]string{"url": action.URL})
		if err != nil {
			return nil, err
		}
		var navigation struct {
			ErrorText  string `json:"errorText"`
			IsDownload bool   `json:"isDownload"`
		}
		if json.Unmarshal(result, &navigation) != nil || navigation.ErrorText != "" || navigation.IsDownload {
			return nil, errors.New("browser_navigation_failed")
		}
		return json.RawMessage(`{"navigated":true}`), nil
	case "reload":
		p.refs = nil
		return p.command(ctx, "Page.reload", nil)
	case "snapshot":
		return p.snapshot(ctx, action.Offset)
	case "fill_form":
		return fillForm(ctx, action.Fields, p.run)
	case "click", "fill", "matches":
		return p.runElementAction(ctx, action)
	case "press":
		return p.press(ctx, action.Key)
	case "scroll":
		return p.command(ctx, "Input.dispatchMouseEvent", map[string]any{
			"type": "mouseWheel", "x": 8, "y": 8, "deltaX": 0, "deltaY": action.DeltaY,
		})
	case "screenshot":
		return p.screenshot(ctx)
	default:
		return nil, errors.New("browser_action_unavailable")
	}
}

// snapshot caps model-visible accessibility text and omits field values.
func (p *page) snapshot(ctx context.Context, offset int) (json.RawMessage, error) {
	p.refs = nil
	if p.documentVersion != nil {
		version, err := p.documentVersion(ctx)
		if err != nil {
			return nil, err
		}
		p.snapshotDocument = version
	}
	result, err := p.command(ctx, "Accessibility.getFullAXTree", nil)
	if err != nil {
		return nil, err
	}
	type value struct {
		Value string `json:"value"`
	}
	var tree struct {
		Nodes []struct {
			NodeID    string `json:"nodeId"`
			ParentID  string `json:"parentId"`
			BackendID int64  `json:"backendDOMNodeId"`
			Ignored   bool   `json:"ignored"`
			Role      value  `json:"role"`
			Name      value  `json:"name"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(result, &tree); err != nil {
		return nil, err
	}
	type entry struct {
		Row  string `json:"row,omitempty"`
		Ref  string `json:"ref,omitempty"`
		Role string `json:"role"`
		Name string `json:"name"`
	}
	p.snapshotVersion++
	p.refs = make(map[string]int64)
	nodes := make([]entry, 0, 100)
	seen := 0
	next := 0
	parents := make(map[string]string)
	rows := make(map[string]string)
	for _, node := range tree.Nodes {
		parents[node.NodeID] = node.ParentID
		if node.Role.Value == "row" {
			rows[node.NodeID] = boundedText(node.Name.Value, 128)
		}
	}
	// Chromium 的原生表格行通常没有名称，优先使用行头，再使用首个有名称的单元格。
	for _, node := range tree.Nodes {
		current, isRow := rows[node.ParentID]
		if isRow && node.Name.Value != "" && (node.Role.Value == "rowheader" || (node.Role.Value == "cell" && current == "")) {
			rows[node.ParentID] = boundedText(node.Name.Value, 128)
		}
	}
	for _, node := range tree.Nodes {
		if node.Ignored || node.Role.Value == "" || (node.Name.Value == "" && !formRole(node.Role.Value)) {
			continue
		}
		seen++
		if seen <= offset {
			continue
		}
		if len(nodes) == cap(nodes) {
			next = seen - 1
			break
		}
		item := entry{Role: boundedText(node.Role.Value, 64), Name: boundedText(node.Name.Value, 256)}
		for id, depth := node.ParentID, 0; id != "" && depth < 64; id, depth = parents[id], depth+1 {
			if row, ok := rows[id]; ok {
				item.Row = row
				break
			}
		}
		if node.BackendID > 0 {
			item.Ref = fmt.Sprintf("e%d_%d", p.snapshotVersion, len(nodes))
			p.refs[item.Ref] = node.BackendID
		}
		nodes = append(nodes, item)
	}
	return json.Marshal(struct {
		Nodes      []entry `json:"nodes"`
		NextOffset int     `json:"nextOffset,omitempty"`
	}{nodes, next})
}

// 未命名表单控件也需要引用，用户可通过行上下文或截图辨认。
func formRole(role string) bool {
	switch role {
	case "textbox", "searchbox", "spinbutton", "combobox", "checkbox", "radio", "switch", "Date", "DateTime", "Time":
		return true
	}
	return false
}

func boundedText(text string, limit int) string {
	characters := []rune(text)
	if len(characters) > limit {
		return string(characters[:limit])
	}
	return text
}

// runElementAction resolves only a reference from the latest snapshot. Fixed
// browser functions keep page script out of the model-facing action contract.
func (p *page) runElementAction(ctx context.Context, action Action) (json.RawMessage, error) {
	if p.documentVersion != nil {
		version, err := p.documentVersion(ctx)
		if err != nil {
			return nil, err
		}
		if version != p.snapshotDocument {
			p.refs = nil
			return nil, errors.New("browser_snapshot_required")
		}
	}
	id, exists := p.refs[action.Ref]
	if !exists {
		return nil, errors.New("browser_snapshot_required")
	}
	result, err := p.command(ctx, "DOM.resolveNode", map[string]any{"backendNodeId": id})
	if err != nil {
		return nil, errors.New("browser_snapshot_required")
	}
	var resolved struct {
		Object struct {
			ID string `json:"objectId"`
		} `json:"object"`
	}
	if json.Unmarshal(result, &resolved) != nil || resolved.Object.ID == "" {
		return nil, errors.New("browser_snapshot_required")
	}
	defer p.command(ctx, "Runtime.releaseObject", map[string]string{"objectId": resolved.Object.ID})
	// 在可见区域命中目标后才发送鼠标事件，避免穿透遮罩点击后台控件。
	script := `async function () {
   if (!this.isConnected || !(this instanceof Element)) return null;
   if (this.matches(':disabled') || this.closest('[inert],[aria-hidden="true"],[aria-disabled="true"]')) return null;
   if (!this.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})) return null;
   this.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
   const hitPoint = () => {
     const r = this.getBoundingClientRect();
     const left = Math.max(0,r.left), right = Math.min(innerWidth,r.right);
     const top = Math.max(0,r.top), bottom = Math.min(innerHeight,r.bottom);
     if (left >= right || top >= bottom) return null;
     const x = (left+right)/2, y = (top+bottom)/2;
     const hit = this.getRootNode().elementFromPoint(x,y);
     return hit && this.contains(hit) ? {x,y} : null;
   };
   // 给滚动容器、固定页脚及弹窗布局一次更新机会，拒绝仍在移动的目标。
   await new Promise(resolve => requestAnimationFrame(resolve));
   const before = hitPoint();
   if (!before) return null;
   await new Promise(resolve => requestAnimationFrame(resolve));
   const after = hitPoint();
   return this.isConnected && after && before.x === after.x && before.y === after.y ? after : null;
 }`
	args := []map[string]string{}
	if action.Name == "fill" || action.Name == "matches" {
		script = `async function (text) {
      // 通过 Chromium 编辑事务替换内容，让编辑器的 input 监听器同步业务模型。
      if (this.isContentEditable && !this.parentElement?.isContentEditable) {
        if (!this.isConnected || this.closest('[inert],[aria-readonly="true"],[aria-disabled="true"]')) return false;
        this.focus();
        if (this.getRootNode().activeElement !== this) return false;
        const doc = this.ownerDocument;
        const range = doc.createRange();
        range.selectNodeContents(this);
        const selection = doc.getSelection();
        if (!selection) return false;
        selection.removeAllRanges();
        selection.addRange(range);
        const expected = text.replace(/\r\n?/g, '\n');
        if (!expected && !range.collapsed) doc.execCommand('delete');
        const lines = expected.split(String.fromCharCode(10));
        for (let index = 0; index < lines.length; index++) {
          if (index) doc.execCommand('insertLineBreak');
          if (lines[index]) doc.execCommand('insertText', false, lines[index]);
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return this.isConnected && (this.innerText === expected || (!expected && !this.textContent));
      }
      if (!this.isConnected || !this.matches('input,textarea,select') || this.disabled || this.readOnly) return false;
      if (this.tagName === 'INPUT' && !['text','search','email','url','tel','password','number','date','datetime-local','month','week','time'].includes(this.type)) return false;
      this.focus();
      if (this.getRootNode().activeElement !== this) return false;
      let expected = text;
      if (this.tagName === 'SELECT') {
        if (this.multiple) return false;
        const options = Array.from(this.options).filter(option => !option.matches(':disabled') && (option.label === text || option.value === text));
        if (options.length !== 1) return false;
        expected = options[0].value;
        this.selectedIndex = options[0].index;
      } else {
        const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(this, text);
      }
      this.dispatchEvent(new Event('input', {bubbles: true}));
      this.dispatchEvent(new Event('change', {bubbles: true}));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return this.isConnected && this.value === expected && this.validity.valid;
    }`
		if action.Name == "matches" {
			script = `function (text) {
      if (this.isConnected && this.isContentEditable && !this.parentElement?.isContentEditable) {
        return this.innerText === text.replace(/\r\n?/g, '\n') || (!text && !this.textContent);
      }
      if (!this.isConnected || !this.matches('textarea,select,input:not([type=password]):not([type=hidden]):not([type=file])')) return null;
      return this.value === text || (this.tagName === 'SELECT' && this.selectedOptions[0]?.label === text);
    }`
		}
		args = append(args, map[string]string{"value": action.Text})
	}
	result, err = p.command(ctx, "Runtime.callFunctionOn", map[string]any{
		"objectId": resolved.Object.ID, "functionDeclaration": script, "arguments": args, "awaitPromise": true, "returnByValue": true,
	})
	if err != nil {
		return nil, err
	}
	if action.Name == "click" {
		var position struct {
			Result struct{ Value *struct{ X, Y float64 } }
		}
		if json.Unmarshal(result, &position) != nil || position.Result.Value == nil {
			return nil, errors.New("browser_element_unavailable")
		}
		point := position.Result.Value
		for _, event := range []string{"mousePressed", "mouseReleased"} {
			if _, err := p.command(ctx, "Input.dispatchMouseEvent", map[string]any{"type": event, "x": point.X, "y": point.Y, "button": "left", "clickCount": 1}); err != nil {
				return nil, err
			}
		}
		return json.RawMessage(`{"applied":true}`), nil
	}
	var reply struct {
		Result struct {
			Value *bool `json:"value"`
		} `json:"result"`
	}
	if json.Unmarshal(result, &reply) != nil || reply.Result.Value == nil {
		return nil, errors.New("browser_element_unavailable")
	}
	if action.Name == "matches" {
		return json.Marshal(map[string]bool{"matches": *reply.Result.Value})
	}
	if !*reply.Result.Value {
		return json.RawMessage(`{"applied":false}`), nil
	}
	return json.RawMessage(`{"applied":true}`), nil
}

// press uses CDP key events so pages receive the browser's default key behavior.
func (p *page) press(ctx context.Context, key string) (json.RawMessage, error) {
	codes := map[string]int{"Enter": 13, "Tab": 9, "Escape": 27, "Backspace": 8, "ArrowUp": 38, "ArrowDown": 40}
	code, ok := codes[key]
	if !ok {
		return nil, errors.New("invalid_browser_key")
	}
	params := map[string]any{"type": "rawKeyDown", "key": key, "code": key, "windowsVirtualKeyCode": code}
	if key == "Enter" {
		params["type"] = "keyDown"
		params["text"] = "\r"
	}
	if _, err := p.command(ctx, "Input.dispatchKeyEvent", params); err != nil {
		return nil, err
	}
	delete(params, "text")
	params["type"] = "keyUp"
	return p.command(ctx, "Input.dispatchKeyEvent", params)
}

// screenshot captures the viewport and bounds the encoded response before
// returning it to the device transport.
func (p *page) screenshot(ctx context.Context) (json.RawMessage, error) {
	result, err := p.command(ctx, "Page.captureScreenshot", map[string]any{
		"format": "jpeg", "quality": 65, "captureBeyondViewport": false,
	})
	if err != nil {
		return nil, err
	}
	if len(result) > 768*1024 {
		return nil, errors.New("browser_screenshot_too_large")
	}
	return result, nil
}
