import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LocalDeviceBrowserActionSchema, LocalDeviceBrowserModeSchema } from "@/shared/localDevice/browser";
import type { JsonSchema, ToolContext, ToolResult } from "../types";

export const LocalBrowserToolInputSchema = z.strictObject({
  operation: LocalDeviceBrowserActionSchema,
  mode: LocalDeviceBrowserModeSchema.optional(),
});

const { $schema: _schema, ...parameters } = z.toJSONSchema(LocalBrowserToolInputSchema, {
  target: "draft-7",
  io: "input",
});
export const localBrowserToolParameters = parameters as JsonSchema;

const ScreenshotSchema = z.object({
  data: z.string().max(768 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

export async function localBrowserToolResult(
  result: unknown,
  isScreenshot: boolean,
  sandbox: ToolContext["sandbox"],
): Promise<ToolResult> {
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    return { content: JSON.stringify(result), isError: true };
  }
  if (!isScreenshot) return { content: JSON.stringify(result) };
  const { data } = ScreenshotSchema.parse(result);
  const bytes = Buffer.from(data, "base64");
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw new Error("invalid_browser_screenshot");
  }
  const directory = "/browser-screenshots";
  const path = `${directory}/${randomUUID()}.jpg`;
  await sandbox.fs.mkdir(directory);
  await sandbox.fs.writeFile(path, bytes);
  return { content: JSON.stringify({ path, mimeType: "image/jpeg" }), changedPaths: [path] };
}
