//go:build darwin || windows

package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"fastgpt.local/local-device/internal/grant"
)

func mustAction(t *testing.T, payload map[string]any) Action {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	action, err := DecodeAction(raw)
	if err != nil {
		t.Fatalf("decode action %s: %v", raw, err)
	}
	return action
}

func findRef(content, pattern string) string {
	re := regexp.MustCompile(pattern + `[^\n]*\[ref=(e\d+)\]`)
	m := re.FindStringSubmatch(content)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

func TestEmbeddedWindowReadsVisiblePage(t *testing.T) {
	directory := os.Getenv("FASTGPT_TEST_EMBEDDED_DIRECTORY")
	if directory == "" {
		t.Skip("set FASTGPT_TEST_EMBEDDED_DIRECTORY to browse in the bundled runtime")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	profile, err := dedicatedProfile(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	pipe, done, err := launchEmbedded(ctx, directory, profile)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		closeContext, stop := context.WithTimeout(context.Background(), 3*time.Second)
		defer stop()
		_, _ = pipe.call(closeContext, "", "Browser.close", nil)
		select {
		case <-done:
		case <-closeContext.Done():
			cancel()
			<-done
		}
	}()
	page, err := openEmbeddedPage(ctx, pipe)
	if err != nil {
		t.Fatalf("start embedded window: %v", err)
	}
	state, err := pipe.call(ctx, "", "Connector.ready", nil)
	if err != nil {
		t.Fatalf("read window state: %v", err)
	}
	var display struct {
		Title       string
		DockVisible *bool
	}
	title := "伯仁连接器"
	if err := json.Unmarshal(state, &display); err != nil || display.Title != title || display.DockVisible == nil || *display.DockVisible != (runtime.GOOS == "darwin") {
		t.Fatalf("embedded window title or Dock visibility was incorrect: %s (%v)", state, err)
	}
	fixture := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/fail" {
			response.Header().Set("Content-Type", "application/json")
			response.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(response, `{"code":"ITR_ROUTE_RULE_NOT_MATCHED"}`)
			return
		}
		response.Header().Set("Content-Type", "text/html")
		if request.URL.Path == "/finance" {
			_, _ = io.WriteString(response, `<meta charset="utf-8"><title>预算预测</title>
			  <div class="el-table">
			    <div class="el-table__header-wrapper"><table><thead><tr><th>分类</th><th>科目</th><th>2025-07</th><th>2026-07</th></tr></thead></table></div>
			    <div class="el-table__body-wrapper"><table><tbody>
			      <tr><td rowspan="2" class="is-hidden">收入</td><td class="is-hidden">毛收入</td><td>181461.28</td><td>-</td></tr>
			      <tr><td class="is-hidden">净收入</td><td>181461.28</td><td>181461.28</td></tr>
			    </tbody></table></div>
			    <div class="el-table__fixed"><table><tbody>
			      <tr><td rowspan="2">收入</td><td>毛收入</td></tr>
			      <tr><td>净收入</td></tr>
			    </tbody></table></div>
			  </div>
			  <div class="split-wrap" style="display:flex">
			    <table><thead><tr><th>财务项</th></tr></thead><tbody><tr><td>净现金流</td></tr></tbody></table>
			    <div>
			      <table><thead><tr><th>2026-07</th><th>2026-09</th></tr></thead></table>
			      <table><tbody><tr><td>-1257.98</td><td>192348.95</td></tr></tbody></table>
			    </div>
			  </div>
			  <div style="position:relative;width:max-content">
			    <button id="transient-btn" onclick="this.dataset.clicked='1'">去处理</button>
			    <div id="mask" class="el-loading-mask" style="position:absolute;inset:0">拼命加载中</div>
			  </div>
			  <button id="noop-btn">无操作按钮</button>
			  <script>setTimeout(()=>document.getElementById('mask')?.remove(),450);</script>`)
			return
		}
		if request.URL.Path == "/tab2" {
			_, _ = io.WriteString(response, `<meta charset="utf-8"><title>第二标签</title>
			  <input aria-label="备注" name="note"><button onclick="document.title='tab2:'+document.querySelector('input').value">保存备注</button>`)
			return
		}
		if request.URL.Path == "/long" {
			for i := 0; i < 400; i++ {
				fmt.Fprintf(response, "<button>row%d</button>", i)
			}
			return
		}
		_, _ = io.WriteString(response, `<meta charset="utf-8"><title>Embedded browser fixture</title>
		  <form onsubmit="event.preventDefault();localStorage.setItem('saved',this.query.value);document.title='submitted:'+this.query.value">
		    <input aria-label="Query" name="query"><button>Response from the visible page</button>
		  </form><script>document.querySelector('input').value=localStorage.getItem('saved')||''</script>
		  <div contenteditable="true" role="textbox" aria-label="问题描述" oninput="document.querySelector('output').textContent='已同步：'+this.innerText"><p><b>旧描述</b></p></div><output></output>
          <table><tr><th>OP-001</th><td><input type="number" min="0" aria-label="金额"></td></tr>
            <tr><th>OP-002</th><td><input type="number" min="0" aria-label="金额"></td></tr></table>
          <select aria-label="阶段"><option value="open">跟进</option><option value="closed">成交</option></select>
          <div style="position:relative;width:max-content"><button>Covered</button><div style="position:absolute;inset:0"></div></div>
          <div class="drawer" role="dialog" aria-label="抽屉"><button onclick="triggerFail()">触发接口与闪现提示</button></div>
          <script>function triggerFail(){fetch('/api/fail',{method:'POST',body:'{"a":1}'});const m=document.createElement('div');m.className='el-message';m.textContent='规则未匹配';document.body.appendChild(m);setTimeout(()=>m.remove(),200);}</script>
          <button style="display:none">Hidden button</button>`)
	}))
	defer fixture.Close()
	if _, err := page.run(ctx, mustAction(t, map[string]any{"action": "navigate", "url": fixture.URL + "/"})); err != nil {
		t.Fatalf("navigate embedded window: %v", err)
	}
	registry := &Registry{}
	window := &dedicatedWindow{page: page, pipe: pipe, done: done, stop: cancel, manual: true}
	registry.windows.Store(profile, window)
	registry.unboundWindows.Store(profile, window)
	if _, err := pipe.call(ctx, "", "Connector.focus", map[string]bool{"management": true}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-pipe.management:
	case <-ctx.Done():
		t.Fatal("management view did not request state")
	}
	if _, err := pipe.call(ctx, "", "Connector.focus", map[string]bool{"management": false}); err != nil {
		t.Fatal(err)
	}
	owner := grant.Owner{TeamID: "team", MemberID: "member", DeviceID: "device"}
	if err := registry.BindDedicated(ctx, owner, "chat", 1, profile); err != nil {
		t.Fatalf("adopt the already open page: %v", err)
	}

	readSnap := func(offset int, maxChars ...int) (string, int) {
		t.Helper()
		payload := map[string]any{"action": "snapshot", "offset": offset}
		if len(maxChars) > 0 {
			payload["maxChars"] = maxChars[0]
		}
		raw, err := page.run(ctx, mustAction(t, payload))
		if err != nil {
			t.Fatal(err)
		}
		var res struct {
			OK         bool   `json:"ok"`
			Content    string `json:"content"`
			NextOffset int    `json:"nextOffset"`
		}
		if err := json.Unmarshal(raw, &res); err != nil || !res.OK {
			t.Fatalf("snapshot failed: %s (%v)", raw, err)
		}
		return res.Content, res.NextOffset
	}

	raw, err := registry.Run(ctx, owner, Request{
		OperationID: "read-0", GrantID: "chat", GrantVersion: 1,
		Action: mustAction(t, map[string]any{"action": "snapshot"}),
	})
	if err != nil || !strings.Contains(string(raw), "Response from the visible page") {
		t.Fatalf("initial snapshot failed: %s (%v)", raw, err)
	}
	snap, _ := readSnap(0)
	amount := findRef(snap, `OP-002[\s\S]{0,80}spinbutton "金额"`)
	stage := findRef(snap, `combobox "阶段"`)
	if amount == "" || stage == "" {
		t.Fatalf("missing refs in snapshot:\n%s", snap)
	}
	res, err := page.run(ctx, mustAction(t, map[string]any{
		"action": "fill_form",
		"fields": []map[string]any{
			{"ref": amount, "value": "200"},
			{"ref": stage, "value": []string{"成交"}},
		},
	}))
	if err != nil || !strings.Contains(string(res), `"failed":0`) {
		t.Fatalf("fill_form: %s %v", res, err)
	}

	// 测试页没有三色发光光标元素，截图中的橙/绿/蓝发光像素来自连接器绘制的操作指针。
	deadline := time.Now().Add(1500 * time.Millisecond)
	for {
		raw, err := page.run(ctx, mustAction(t, map[string]any{"action": "screenshot"}))
		if err != nil {
			t.Fatal(err)
		}
		var capture struct{ Data []byte }
		if err := json.Unmarshal(raw, &capture); err != nil {
			t.Fatal(err)
		}
		frame, err := jpeg.Decode(bytes.NewReader(capture.Data))
		if err != nil {
			t.Fatal(err)
		}
		colored := 0
		for y := 0; y < frame.Bounds().Dy(); y += 2 {
			for x := 0; x < frame.Bounds().Dx(); x += 2 {
				r, g, b, _ := frame.At(x, y).RGBA()
				maxC := max(r, g, b)
				minC := min(r, g, b)
				if maxC-minC > 14000 {
					colored++
				}
			}
		}
		if colored > 15 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("agent pointer missing from browser screenshot after fill")
		}
		time.Sleep(30 * time.Millisecond)
	}

	rich := findRef(snap, `textbox "问题描述"`)
	for _, value := range []string{"中文联测\n第二行", "", "浏览器联测，无业务故障"} {
		result, err := page.run(ctx, mustAction(t, map[string]any{"action": "fill", "ref": rich, "text": value}))
		if err != nil || !strings.Contains(string(result), `"ok":true`) {
			t.Fatalf("rich text fill %q: %s %v", value, result, err)
		}
	}
	snap, _ = readSnap(0)
	if !strings.Contains(snap, "已同步：浏览器联测，无业务故障") {
		t.Fatal("rich text model did not observe input event")
	}
	covered := findRef(snap, `button "Covered"`)
	if got, err := page.run(ctx, mustAction(t, map[string]any{"action": "click", "ref": covered})); err != nil || !strings.Contains(string(got), `"not_clickable"`) {
		t.Fatalf("covered click: %s %v", got, err)
	}
	if got, err := page.run(ctx, mustAction(t, map[string]any{"action": "click", "ref": covered, "force": true})); err != nil || !strings.Contains(string(got), `"bypassedOcclusion"`) {
		t.Fatalf("force click should report bypassedOcclusion: %s %v", got, err)
	}
	drawerRaw, err := page.run(ctx, mustAction(t, map[string]any{"action": "snapshot", "selector": ".drawer"}))
	if err != nil || !strings.Contains(string(drawerRaw), "触发接口与闪现提示") || strings.Contains(string(drawerRaw), "OP-001") {
		t.Fatalf("scoped selector snapshot: %s %v", drawerRaw, err)
	}
	var drawerRes struct{ Content string }
	_ = json.Unmarshal(drawerRaw, &drawerRes)
	trigger := findRef(drawerRes.Content, `button "触发接口与闪现提示"`)
	if trigger == "" {
		t.Fatalf("missing trigger ref in:\n%s", drawerRes.Content)
	}
	if got, err := page.run(ctx, mustAction(t, map[string]any{"action": "click", "ref": trigger})); err != nil ||
		!strings.Contains(string(got), "ITR_ROUTE_RULE_NOT_MATCHED") ||
		!strings.Contains(string(got), "规则未匹配") {
		t.Fatalf("expected failedRequests and uiEvents on click: %s %v", got, err)
	}
	if got, err := page.run(ctx, mustAction(t, map[string]any{"action": "click", "selector": ".drawer button"})); err != nil || !strings.Contains(string(got), `"ok":true`) {
		t.Fatalf("click by fallback selector: %s %v", got, err)
	}
	if netRes, err := page.run(ctx, mustAction(t, map[string]any{"action": "network", "failedOnly": true})); err != nil || !strings.Contains(string(netRes), "ITR_ROUTE_RULE_NOT_MATCHED") {
		t.Fatalf("network failedOnly: %s %v", netRes, err)
	}
	harPath := t.TempDir() + "/trace.har"
	if traceRes, err := page.run(ctx, mustAction(t, map[string]any{"action": "trace", "op": "export_har", "path": harPath})); err != nil || !strings.Contains(string(traceRes), `"ok":true`) {
		t.Fatalf("trace export_har: %s %v", traceRes, err)
	} else if harBytes, readErr := os.ReadFile(harPath); readErr != nil || !strings.Contains(string(harBytes), "ITR_ROUTE_RULE_NOT_MATCHED") {
		t.Fatalf("exported HAR missing failure entry: %v", readErr)
	}
	query := findRef(snap, `textbox "Query"`)
	if _, err := page.run(ctx, mustAction(t, map[string]any{
		"action": "batch",
		"actions": []map[string]any{
			{"action": "fill", "ref": query, "text": "伯仁验收"},
			{"action": "press", "key": "Enter"},
		},
	})); err != nil {
		t.Fatal(err)
	}
	if _, err := page.run(ctx, mustAction(t, map[string]any{"action": "reload"})); err != nil {
		t.Fatal(err)
	}
	if got, err := page.run(ctx, mustAction(t, map[string]any{"action": "click", "ref": query})); err != nil || !strings.Contains(string(got), `"ref_not_found"`) {
		t.Fatalf("reload retained old reference: %s %v", got, err)
	}
	snap, _ = readSnap(0)
	if !strings.Contains(snap, "伯仁验收") {
		t.Fatalf("saved value missing after reload:\n%s", snap)
	}
	ext, err := page.run(ctx, mustAction(t, map[string]any{"action": "extract"}))
	if err != nil || !strings.Contains(string(ext), "OP-001") {
		t.Fatalf("extract markdown table: %s %v", ext, err)
	}
	evalRes, err := page.run(ctx, mustAction(t, map[string]any{"action": "evaluate", "script": "document.querySelector('input[name=query]').value"}))
	if err != nil || !strings.Contains(string(evalRes), "伯仁验收") {
		t.Fatalf("evaluate: %s %v", evalRes, err)
	}
	multiEval, err := page.run(ctx, mustAction(t, map[string]any{"action": "evaluate", "script": "const v = document.querySelector('input[name=query]').value; const res = ['ok', v]; res.join(':')"}))
	if err != nil || !strings.Contains(string(multiEval), "ok:伯仁验收") {
		t.Fatalf("evaluate multi-statement completion value: %s %v", multiEval, err)
	}

	// 宽表抽取（rowspan + el-table 冻结列 + 自定义分表）、瞬时遮罩自动等待、空操作检测、快照行折叠。
	if _, err := page.run(ctx, mustAction(t, map[string]any{"action": "navigate", "url": fixture.URL + "/finance"})); err != nil {
		t.Fatal(err)
	}
	finSnap, _ := readSnap(0)
	if !strings.Contains(finSnap, `row "收入 | 毛收入 | 181461.28 | -"`) || !strings.Contains(finSnap, `row "净收入 | 181461.28 | 181461.28"`) {
		t.Fatalf("expected collapsed table row in snapshot:\n%s", finSnap)
	}
	tablesRaw, err := page.run(ctx, mustAction(t, map[string]any{"action": "extract", "format": "tables"}))
	var extractRes struct {
		OK      bool   `json:"ok"`
		Content string `json:"content"`
	}
	if err != nil || json.Unmarshal(tablesRaw, &extractRes) != nil || !extractRes.OK ||
		!strings.Contains(extractRes.Content, `["收入","毛收入","181461.28","-"]`) ||
		!strings.Contains(extractRes.Content, `["收入","净收入","181461.28","181461.28"]`) ||
		!strings.Contains(extractRes.Content, `["财务项","2026-07","2026-09"]`) ||
		!strings.Contains(extractRes.Content, `["净现金流","-1257.98","192348.95"]`) {
		t.Fatalf("extract tables failed to expand rowspan or stitch split tables: %s %v", tablesRaw, err)
	}
	transientBtn := findRef(finSnap, `button "去处理"`)
	noopBtn := findRef(finSnap, `button "无操作按钮"`)
	if transientBtn == "" || noopBtn == "" {
		t.Fatalf("missing finance buttons in:\n%s", finSnap)
	}
	if got, err := page.run(ctx, mustAction(t, map[string]any{"action": "click", "ref": transientBtn})); err != nil || !strings.Contains(string(got), `"ok":true`) {
		t.Fatalf("transient loading mask should auto-wait and succeed: %s %v", got, err)
	}
	if got, err := page.run(ctx, mustAction(t, map[string]any{"action": "click", "ref": noopBtn})); err != nil || !strings.Contains(string(got), `"none":true`) {
		t.Fatalf("noop click should report effect.none=true: %s %v", got, err)
	}
	if idleRes, err := page.run(ctx, mustAction(t, map[string]any{"action": "wait_for", "event": "idle", "timeout": 3})); err != nil || !strings.Contains(string(idleRes), `"idle":true`) {
		t.Fatalf("wait_for idle: %s %v", idleRes, err)
	}

	// 多标签后台操作与跨标签唯一 ref 路由。
	tabOpenRaw, err := page.run(ctx, mustAction(t, map[string]any{"action": "tabs", "op": "new", "url": fixture.URL + "/tab2", "activate": false}))
	if err != nil || !strings.Contains(string(tabOpenRaw), `"openedTabId"`) {
		t.Fatalf("tabs new background: %s %v", tabOpenRaw, err)
	}
	var tabOpen struct {
		OpenedTabID int `json:"openedTabId"`
	}
	_ = json.Unmarshal(tabOpenRaw, &tabOpen)
	tab2SnapRaw, err := page.run(ctx, mustAction(t, map[string]any{"action": "snapshot", "tabId": tabOpen.OpenedTabID}))
	if err != nil || !strings.Contains(string(tab2SnapRaw), "保存备注") {
		t.Fatalf("background tab snapshot: %s %v", tab2SnapRaw, err)
	}
	var tab2Snap struct{ Content string }
	_ = json.Unmarshal(tab2SnapRaw, &tab2Snap)
	noteRef := findRef(tab2Snap.Content, `textbox "备注"`)
	saveRef := findRef(tab2Snap.Content, `button "保存备注"`)
	// 不传 tabId、不切换前台标签，直接通过 ref 路由到后台标签完成填写与点击。
	if fillRes, err := page.run(ctx, mustAction(t, map[string]any{"action": "fill", "ref": noteRef, "text": "后台填写"})); err != nil || !strings.Contains(string(fillRes), `"ok":true`) {
		t.Fatalf("cross-tab ref fill: %s %v", fillRes, err)
	}
	if clickRes, err := page.run(ctx, mustAction(t, map[string]any{"action": "click", "ref": saveRef})); err != nil || !strings.Contains(string(clickRes), "tab2:后台填写") {
		t.Fatalf("cross-tab ref click: %s %v", clickRes, err)
	}
	if _, err := page.run(ctx, mustAction(t, map[string]any{"action": "tabs", "op": "close", "tabId": tabOpen.OpenedTabID})); err != nil {
		t.Fatal(err)
	}
	if _, err := page.run(ctx, mustAction(t, map[string]any{"action": "navigate", "url": fixture.URL + "/long"})); err != nil {
		t.Fatal(err)
	}
	offset := 0
	for {
		content, next := readSnap(offset, 4000)
		if strings.Contains(content, "row399") {
			if offset == 0 {
				t.Fatal("expected paginated result")
			}
			break
		}
		if next == 0 {
			t.Fatal("missing last button")
		}
		offset = next
	}
	registry.Revoke(owner, "chat", 1)
	if registry.Has(owner, "chat", 1) {
		t.Fatal("revoked grant still active")
	}
	if _, err := pipe.call(ctx, "", "Connector.ready", nil); err != nil {
		t.Fatalf("revocation closed the user's window: %v", err)
	}
}
