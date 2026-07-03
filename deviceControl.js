import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { chromium } from 'playwright';

const execPromise = promisify(exec);

/**
 * Generates points along a cubic Bezier curve.
 */
export function generateBezierPath(start, end, steps = 30) {
  const points = [];
  const ctrl1 = {
    x: start.x + (end.x - start.x) * 0.25 + (Math.random() - 0.5) * 50,
    y: start.y + (end.y - start.y) * 0.25 + (Math.random() - 0.5) * 50
  };
  const ctrl2 = {
    x: start.x + (end.x - start.x) * 0.75 + (Math.random() - 0.5) * 50,
    y: start.y + (end.y - start.y) * 0.75 + (Math.random() - 0.5) * 50
  };

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Ease-in-out quadratic mapping
    const easeT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const mt = 1 - easeT;

    const x = mt*mt*mt * start.x + 3 * mt*mt * easeT * ctrl1.x + 3 * mt * easeT*easeT * ctrl2.x + easeT*easeT*easeT * end.x;
    const y = mt*mt*mt * start.y + 3 * mt*mt * easeT * ctrl1.y + 3 * mt * easeT*easeT * ctrl2.y + easeT*easeT*easeT * end.y;

    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  return points;
}

/**
 * Superimposes a high-contrast Visual Ruler over the image buffer (ticks and pixel values
 * along the borders, thin dashed grid lines projecting across the screen),
 * and composites the raw screenshot and the gridded screenshot side-by-side.
 */
export async function createVisualGrid(imageBuffer, columns = 10, rows = 10) {
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const { width, height } = metadata;

  // Generate SVG Grid overlay with rulers on the borders
  let svgParts = [`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`];
  
  svgParts.push(`
    <style>
      .grid-line-major { stroke: rgba(255, 255, 255, 0.4); stroke-width: 1; stroke-dasharray: 4,4; }
      .grid-line-major-shadow { stroke: rgba(0, 0, 0, 0.5); stroke-width: 3; stroke-dasharray: 4,4; }
      .ruler-tick-major { stroke: white; stroke-width: 2; }
      .ruler-tick-major-shadow { stroke: black; stroke-width: 4; }
      .ruler-tick-minor { stroke: rgba(255, 255, 255, 0.6); stroke-width: 1; }
      .ruler-tick-minor-shadow { stroke: rgba(0, 0, 0, 0.8); stroke-width: 3; }
      .ruler-text { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: bold; fill: white; text-anchor: middle; dominant-baseline: middle; }
      .ruler-text-shadow { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: bold; fill: black; stroke: black; stroke-width: 3; paint-order: stroke; text-anchor: middle; dominant-baseline: middle; }
    </style>
  `);

  // Draw Vertical lines and X labels
  for (let col = 1; col < columns; col++) {
    const x = Math.round((width / columns) * col);
    
    // Major Grid Line (vertical)
    svgParts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" class="grid-line-major-shadow" />`);
    svgParts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" class="grid-line-major" />`);

    // Top X Labels
    svgParts.push(`<text x="${x}" y="15" class="ruler-text-shadow">${x}</text>`);
    svgParts.push(`<text x="${x}" y="15" class="ruler-text">${x}</text>`);

    // Bottom X Labels
    svgParts.push(`<text x="${x}" y="${height - 15}" class="ruler-text-shadow">${x}</text>`);
    svgParts.push(`<text x="${x}" y="${height - 15}" class="ruler-text">${x}</text>`);
  }

  // Draw X ticks (every 2% of width as minor ticks, every 10% as major)
  const xDivisions = columns * 5; // 50 divisions total
  for (let i = 0; i <= xDivisions; i++) {
    const x = Math.round((width / xDivisions) * i);
    const isMajor = i % 5 === 0;
    const tickLen = isMajor ? 12 : 6;
    
    if (isMajor) {
      // Top major tick
      svgParts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${tickLen}" class="ruler-tick-major-shadow" />`);
      svgParts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${tickLen}" class="ruler-tick-major" />`);
      // Bottom major tick
      svgParts.push(`<line x1="${x}" y1="${height}" x2="${x}" y2="${height - tickLen}" class="ruler-tick-major-shadow" />`);
      svgParts.push(`<line x1="${x}" y1="${height}" x2="${x}" y2="${height - tickLen}" class="ruler-tick-major" />`);
    } else {
      // Top minor tick
      svgParts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${tickLen}" class="ruler-tick-minor-shadow" />`);
      svgParts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${tickLen}" class="ruler-tick-minor" />`);
      // Bottom minor tick
      svgParts.push(`<line x1="${x}" y1="${height}" x2="${x}" y2="${height - tickLen}" class="ruler-tick-minor-shadow" />`);
      svgParts.push(`<line x1="${x}" y1="${height}" x2="${x}" y2="${height - tickLen}" class="ruler-tick-minor" />`);
    }
  }

  // Draw Horizontal lines and Y labels
  for (let row = 1; row < rows; row++) {
    const y = Math.round((height / rows) * row);

    // Major Grid Line (horizontal)
    svgParts.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" class="grid-line-major-shadow" />`);
    svgParts.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" class="grid-line-major" />`);

    // Left Y Labels
    svgParts.push(`<text x="${22}" y="${y}" class="ruler-text-shadow">${y}</text>`);
    svgParts.push(`<text x="${22}" y="${y}" class="ruler-text">${y}</text>`);

    // Right Y Labels
    svgParts.push(`<text x="${width - 22}" y="${y}" class="ruler-text-shadow">${y}</text>`);
    svgParts.push(`<text x="${width - 22}" y="${y}" class="ruler-text">${y}</text>`);
  }

  // Draw Y ticks (every 2% of height as minor ticks, every 10% as major)
  const yDivisions = rows * 5; // 50 divisions total
  for (let i = 0; i <= yDivisions; i++) {
    const y = Math.round((height / yDivisions) * i);
    const isMajor = i % 5 === 0;
    const tickLen = isMajor ? 12 : 6;

    if (isMajor) {
      // Left major tick
      svgParts.push(`<line x1="0" y1="${y}" x2="${tickLen}" class="ruler-tick-major-shadow" />`);
      svgParts.push(`<line x1="0" y1="${y}" x2="${tickLen}" class="ruler-tick-major" />`);
      // Right major tick
      svgParts.push(`<line x1="${width}" y1="${y}" x2="${width - tickLen}" class="ruler-tick-major-shadow" />`);
      svgParts.push(`<line x1="${width}" y1="${y}" x2="${width - tickLen}" class="ruler-tick-major" />`);
    } else {
      // Left minor tick
      svgParts.push(`<line x1="0" y1="${y}" x2="${tickLen}" class="ruler-tick-minor-shadow" />`);
      svgParts.push(`<line x1="0" y1="${y}" x2="${tickLen}" class="ruler-tick-minor" />`);
      // Right minor tick
      svgParts.push(`<line x1="${width}" y1="${y}" x2="${width - tickLen}" class="ruler-tick-minor-shadow" />`);
      svgParts.push(`<line x1="${width}" y1="${y}" x2="${width - tickLen}" class="ruler-tick-minor" />`);
    }
  }

  svgParts.push('</svg>');

  const gridOverlayBuffer = Buffer.from(svgParts.join(''));
  
  // Composite the grid on top of the original image
  const griddedImageBuffer = await sharp(imageBuffer)
    .composite([{ input: gridOverlayBuffer, top: 0, left: 0 }])
    .toBuffer();

  // Combine both images side-by-side
  return sharp({
    create: {
      width: width * 2,
      height: height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    }
  })
  .composite([
    { input: imageBuffer, top: 0, left: 0 },
    { input: griddedImageBuffer, top: 0, left: width }
  ])
  .png()
  .toBuffer();
}

/**
 * Android ADB Device Adapter
 */
export class AdbAdapter {
  constructor(serial) {
    this.serial = serial;
  }

  async getScreenshot() {
    const cmd = this.serial ? `adb -s ${this.serial} exec-out screencap -p` : `adb exec-out screencap -p`;
    const { stdout } = await execPromise(cmd, { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  }

  async click(x, y) {
    const cmd = this.serial ? `adb -s ${this.serial} shell input tap ${x} ${y}` : `adb shell input tap ${x} ${y}`;
    await execPromise(cmd);
  }

  async type(text) {
    // ADB text input has issues with spaces and special chars; escape space as %s
    const escaped = text.replace(/ /g, '%s');
    const cmd = this.serial ? `adb -s ${this.serial} shell input text "${escaped}"` : `adb shell input text "${escaped}"`;
    await execPromise(cmd);
  }

  async swipe(fromX, fromY, toX, toY, duration = 300) {
    const cmd = this.serial 
      ? `adb -s ${this.serial} shell input swipe ${fromX} ${fromY} ${toX} ${toY} ${duration}`
      : `adb shell input swipe ${fromX} ${fromY} ${toX} ${toY} ${duration}`;
    await execPromise(cmd);
  }

  async navigate(url) {
    const cmd = this.serial 
      ? `adb -s ${this.serial} shell am start -a android.intent.action.VIEW -d "${url}"`
      : `adb shell am start -a android.intent.action.VIEW -d "${url}"`;
    await execPromise(cmd);
  }

  async scroll(x, y, deltaX, deltaY) {
    // Translate scrolling deltas to screen swipe movements (scroll down = swipe up)
    const endX = x - deltaX;
    const endY = y - deltaY;
    await this.swipe(x, y, endX, endY, 300);
  }
}

/**
 * Playwright Chromium Browser Adapter
 */
export class BrowserAdapter {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async init() {
    if (!this.browser) {
      // Launch in headful mode to make the browser visible to the user
      this.browser = await chromium.launch({ headless: false });
      this.context = await this.browser.newContext({ viewport: { width: 1280, height: 720 } });
      this.page = await this.context.newPage();
      await this.page.goto('about:blank');
    }
  }

  async getScreenshot() {
    await this.init();
    return this.page.screenshot({ type: 'png' });
  }

  async click(x, y) {
    await this.init();
    await this.page.mouse.click(x, y);
  }

  async type(text) {
    await this.init();
    await this.page.keyboard.type(text);
  }

  async swipe(fromX, fromY, toX, toY, duration = 300) {
    await this.init();
    const points = generateBezierPath({ x: fromX, y: fromY }, { x: toX, y: toY }, 20);
    await this.page.mouse.move(fromX, fromY);
    await this.page.mouse.down();
    const delay = Math.round(duration / points.length);
    for (const point of points) {
      await this.page.mouse.move(point.x, point.y);
      await new Promise(r => setTimeout(r, delay));
    }
    await this.page.mouse.up();
  }

  async navigate(url) {
    await this.init();
    await this.page.goto(url);
  }

  async scroll(x, y, deltaX, deltaY) {
    await this.init();
    await this.page.mouse.move(x, y);
    await this.page.mouse.wheel(deltaX, deltaY);
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}

/**
 * Native Linux Desktop OS Adapter
 */
export class DesktopAdapter {
  async getScreenshot() {
    const tempPath = path.join('/tmp', `desktop_${Date.now()}.png`);
    // Run spectacle in background non-interactive mode
    await execPromise(`spectacle -b -n -o "${tempPath}"`);
    const buffer = await fs.readFile(tempPath);
    await fs.unlink(tempPath);
    return buffer;
  }

  async click(x, y) {
    // Falls back to xdotool on Xwayland/X11 clients
    try {
      await execPromise(`xdotool mousemove ${x} ${y} click 1`);
    } catch (e) {
      console.warn("Desktop click warning (check if xdotool is installed or Wayland session allows mapping):", e.message);
    }
  }

  async type(text) {
    try {
      await execPromise(`xdotool type "${text}"`);
    } catch (e) {
      console.warn("Desktop type warning:", e.message);
    }
  }

  async swipe(fromX, fromY, toX, toY, duration = 300) {
    try {
      const points = generateBezierPath({ x: fromX, y: fromY }, { x: toX, y: toY }, 15);
      await execPromise(`xdotool mousemove ${fromX} ${fromY} mousedown 1`);
      const delay = Math.round(duration / points.length);
      for (const pt of points) {
        await execPromise(`xdotool mousemove ${pt.x} ${pt.y}`);
        await new Promise(r => setTimeout(r, delay));
      }
      await execPromise(`xdotool mouseup 1`);
    } catch (e) {
      console.warn("Desktop swipe warning:", e.message);
    }
  }

  async navigate(url) {
    try {
      await execPromise(`xdg-open "${url}"`);
    } catch (e) {
      console.warn("Desktop navigate warning:", e.message);
    }
  }

  async scroll(x, y, deltaX, deltaY) {
    try {
      // Hover at coordinates
      await execPromise(`xdotool mousemove ${x} ${y}`);
      
      // Vertical scroll
      if (deltaY !== 0) {
        const button = deltaY > 0 ? 5 : 4; // 5 is down, 4 is up
        const count = Math.max(1, Math.round(Math.abs(deltaY) / 100));
        await execPromise(`xdotool click --repeat ${count} ${button}`);
      }

      // Horizontal scroll
      if (deltaX !== 0) {
        const button = deltaX > 0 ? 7 : 6; // 7 is right, 6 is left
        const count = Math.max(1, Math.round(Math.abs(deltaX) / 100));
        await execPromise(`xdotool click --repeat ${count} ${button}`);
      }
    } catch (e) {
      console.warn("Desktop scroll warning:", e.message);
    }
  }
}

/**
 * Singleton Device Controller and Manager
 */
class DeviceManager {
  constructor() {
    this.adapters = new Map();
    this.adapters.set('computer', new DesktopAdapter());
  }

  async listDevices() {
    const devices = [{ id: 'computer', type: 'host_desktop' }];
    
    // Check ADB devices
    try {
      const { stdout } = await execPromise('adb devices');
      const lines = stdout.trim().split('\n').slice(1);
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts[0] && parts[1] === 'device') {
          devices.push({ id: parts[0], type: 'android_adb' });
          if (!this.adapters.has(parts[0])) {
            this.adapters.set(parts[0], new AdbAdapter(parts[0]));
          }
        }
      }
    } catch {}

    // Check if virtual chromium exists in map, if not register it
    if (!this.adapters.has('browser')) {
      this.adapters.set('browser', new BrowserAdapter());
    }
    devices.push({ id: 'browser', type: 'virtual_chromium' });

    return devices;
  }

  getAdapter(deviceId) {
    if (!this.adapters.has(deviceId)) {
      if (deviceId === 'browser') {
        this.adapters.set('browser', new BrowserAdapter());
      } else {
        this.adapters.set(deviceId, new AdbAdapter(deviceId));
      }
    }
    return this.adapters.get(deviceId);
  }
}

export const deviceManager = new DeviceManager();
