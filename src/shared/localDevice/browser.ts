import { z } from 'zod';

export const LocalDeviceBrowserModeSchema = z.enum(['dedicated', 'sharedTab']);

const elementRef = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/)
  .describe('Element ref from a snapshot (e.g. e12); refs are unique across tabs');

const navigationUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  }, 'Expected HTTP or HTTPS without credentials');

const withTab = {
  tabId: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Target tab id from page.tabs / tabs list. Omit to use the tab owning `ref`, else the active tab. Non-active tabs run in the background.'
    )
};

const withSnapshot = {
  snapshot: z
    .boolean()
    .optional()
    .describe('Set true to attach the updated accessibility snapshot in the action response'),
  ...withTab
};

const singleActions = [
  z.strictObject({ action: z.literal('navigate'), url: navigationUrl, ...withSnapshot }),
  z.strictObject({ action: z.literal('go_back'), ...withSnapshot }),
  z.strictObject({ action: z.literal('go_forward'), ...withSnapshot }),
  z.strictObject({ action: z.literal('reload'), ...withSnapshot }),
  z.strictObject({
    action: z.literal('snapshot'),
    ref: elementRef.optional().describe('Optional ref to snapshot only that subtree'),
    selector: z
      .string()
      .max(512)
      .optional()
      .describe('Optional CSS selector (e.g. ".el-drawer", ".el-select-dropdown") to snapshot only that container'),
    offset: z.number().int().min(0).max(2147483647).optional(),
    maxChars: z.number().int().min(500).max(40000).optional(),
    interactive: z.boolean().optional().describe('Only include interactive elements'),
    formOnly: z.boolean().optional().describe('Only include form controls, buttons and dialogs'),
    ...withTab
  }),
  z.strictObject({
    action: z.literal('click'),
    ref: elementRef.optional(),
    selector: z
      .string()
      .max(512)
      .optional()
      .describe('Fallback CSS selector when an icon/control has no accessibility ref (e.g. ".el-dialog__close")'),
    button: z.enum(['left', 'right', 'middle']).optional(),
    doubleClick: z.boolean().optional(),
    modifiers: z
      .array(z.enum(['Alt', 'Control', 'Ctrl', 'Meta', 'Command', 'Cmd', 'Shift', 'ControlOrMeta']))
      .max(4)
      .optional(),
    force: z.boolean().optional().describe('Bypass occlusion checks if covered by an overlay'),
    ...withSnapshot
  }),
  z.strictObject({
    action: z.literal('hover'),
    ref: elementRef.optional(),
    selector: z.string().max(512).optional(),
    ...withSnapshot
  }),
  z.strictObject({
    action: z.literal('type'),
    ref: elementRef.optional(),
    text: z.string().max(8192),
    submit: z.boolean().optional().describe('Press Enter after typing'),
    slowly: z.boolean().optional().describe('Type character by character to trigger search/autocomplete'),
    clear: z.boolean().optional().describe('Clear existing text before typing'),
    ...withSnapshot
  }),
  z.strictObject({
    action: z.literal('fill'),
    ref: elementRef,
    text: z.string().max(16384),
    ...withSnapshot
  }),
  z.strictObject({
    action: z.literal('select_option'),
    ref: elementRef,
    values: z
      .array(z.string().max(512))
      .min(1)
      .max(10)
      .describe('Option text/value(s); pass multiple levels in order for cascader dropdowns'),
    ...withSnapshot
  }),
  z.strictObject({
    action: z.literal('check'),
    ref: elementRef,
    checked: z.boolean(),
    ...withSnapshot
  }),
  z.strictObject({
    action: z.literal('press'),
    key: z.string().min(1).max(64).describe('Key or combo like Enter, Tab, Escape, Control+A'),
    ref: elementRef.optional(),
    ...withSnapshot
  }),
  z.strictObject({
    action: z.literal('scroll'),
    ref: elementRef.optional().describe('Scroll inside this container or scroll it into view'),
    deltaX: z.number().int().min(-8192).max(8192).optional(),
    deltaY: z.number().int().min(-8192).max(8192).optional(),
    to: z.enum(['top', 'bottom']).optional(),
    ...withSnapshot
  }),
  z.strictObject({
    action: z.literal('drag'),
    startRef: elementRef,
    endRef: elementRef,
    ...withSnapshot
  }),
  z.strictObject({
    action: z.literal('upload_file'),
    ref: elementRef,
    paths: z.array(z.string().min(1).max(1024)).min(1).max(20),
    ...withSnapshot
  }),
  z.strictObject({
    action: z.literal('fill_form'),
    fields: z
      .array(
        z.strictObject({
          ref: elementRef,
          value: z.union([
            z.string().max(16384),
            z.boolean(),
            z.array(z.string().max(512)).min(1).max(10)
          ])
        })
      )
      .min(1)
      .max(30)
      .refine(
        (fields) => new Set(fields.map(({ ref }) => ref)).size === fields.length,
        'Duplicate field reference'
      ),
    ...withSnapshot
  }),
  z.strictObject({
    action: z.literal('wait_for'),
    text: z.string().max(512).optional(),
    textGone: z.string().max(512).optional(),
    event: z
      .enum(['toast', 'status', 'loading', 'idle'])
      .optional()
      .describe(
        'toast/status/loading wait for a transient UI event to appear; idle waits until loading masks are gone and network is quiet'
      ),
    seconds: z.number().min(0.1).max(30).optional(),
    timeout: z.number().min(1).max(30).optional(),
    ...withSnapshot
  }),
  z.strictObject({
    action: z.literal('network'),
    urlPattern: z.string().max(512).optional().describe('Case-insensitive substring filter on URL'),
    method: z.string().max(16).optional(),
    statusMin: z.number().int().min(100).max(599).optional(),
    failedOnly: z.boolean().optional().describe('Only return 4xx/5xx or failed requests'),
    clear: z.boolean().optional().describe('Clear captured network buffer'),
    limit: z.number().int().min(1).max(100).optional(),
    ...withTab
  }),
  z.strictObject({
    action: z.literal('trace'),
    op: z.enum(['summary', 'export_har', 'clear']),
    path: z.string().max(1024).optional().describe('Optional local file path for export_har'),
    limit: z.number().int().min(1).max(100).optional(),
    ...withTab
  }),
  z.strictObject({
    action: z.literal('extract'),
    ref: elementRef.optional(),
    format: z
      .enum(['markdown', 'text', 'links', 'tables'])
      .optional()
      .describe(
        'tables returns JSON [{columns, rows}] with merged cells expanded and frozen/split header-body tables joined'
      ),
    offset: z.number().int().min(0).max(2147483647).optional(),
    maxChars: z.number().int().min(500).max(40000).optional(),
    ...withTab
  }),
  z.strictObject({
    action: z.literal('evaluate'),
    script: z.string().min(1).max(32768),
    ref: elementRef.optional(),
    ...withSnapshot
  }),
  z.strictObject({
    action: z.literal('screenshot'),
    ref: elementRef.optional(),
    fullPage: z.boolean().optional(),
    ...withTab
  }),
  z.strictObject({
    action: z.literal('tabs'),
    op: z.enum(['list', 'new', 'select', 'close']),
    index: z.number().int().min(0).max(50).optional().describe('Deprecated: prefer tabId'),
    url: navigationUrl.optional(),
    activate: z
      .boolean()
      .optional()
      .describe('For op=new: false opens the tab in the background'),
    ...withSnapshot
  }),
  z.strictObject({
    action: z.literal('dialog'),
    accept: z.boolean(),
    promptText: z.string().max(2048).optional(),
    ...withSnapshot
  })
] as const;

const SingleBrowserActionSchema = z.discriminatedUnion('action', singleActions);

/** 浏览器动作仅携带页面操作参数，设备与授权由已绑定的会话确定；tabId 只在会话所属浏览器内选择标签。 */
export const LocalDeviceBrowserActionSchema = z.discriminatedUnion('action', [
  ...singleActions,
  z.strictObject({
    action: z.literal('batch'),
    actions: z.array(SingleBrowserActionSchema).min(1).max(20),
    ...withSnapshot
  })
]);

export type LocalDeviceBrowserAction = z.infer<typeof LocalDeviceBrowserActionSchema>;
