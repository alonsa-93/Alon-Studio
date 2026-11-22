/** Types for driver.mjs (the CDP driver for the browser tests). */
export interface Box { x: number; y: number; w: number; h: number }
export interface Driver {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
  viewport(w: number, h: number): Promise<void>;
  goto(url: string): Promise<void>;
  eval(expr: string): Promise<any>;
  waitFor(expr: string, timeout?: number): Promise<void>;
  box(selector: string, text?: string): Promise<Box>;
  clickAt(x: number, y: number, clickCount?: number): Promise<void>;
  click(selector: string, text?: string): Promise<void>;
  key(key: string, mods?: { ctrl?: boolean; shift?: boolean }): Promise<void>;
  type(text: string): Promise<void>;
  screenshot(file: string): Promise<void>;
}
export function launch(opts?: { width?: number; height?: number; port?: number }): Promise<Driver>;
