import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { pino } from 'pino';
import { loadConfig, type AppConfig } from '../src/config/env.js';

export const silentLogger = pino({ level: 'silent' });

export type RGB = [number, number, number];
export const RED: RGB = [220, 30, 30];
export const GREEN: RGB = [30, 200, 60];
export const BLUE: RGB = [30, 60, 220];
export const YELLOW: RGB = [240, 220, 20];

/** Quadrants: TL red, TR green, BL blue, BR yellow. Non-square so rotations are detectable. */
export async function quadrantImage(width = 64, height = 32): Promise<Sharp> {
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = y < height / 2 ? (x < width / 2 ? RED : GREEN) : x < width / 2 ? BLUE : YELLOW;
      px.set(c, (y * width + x) * 3);
    }
  }
  return sharp(px, { raw: { width, height, channels: 3 } });
}

/** Deterministic noisy gradient: compresses like a photo (quality actually matters). */
export function photoLike(width = 800, height = 600, channels: 3 | 4 = 3): Sharp {
  const px = Buffer.alloc(width * height * channels);
  let seed = 42;
  const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff) * 60 - 30;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      px[i] = Math.max(0, Math.min(255, (x / width) * 255 + rand()));
      px[i + 1] = Math.max(0, Math.min(255, (y / height) * 255 + rand()));
      px[i + 2] = Math.max(0, Math.min(255, 128 + Math.sin(x / 17) * 60 + rand()));
      if (channels === 4) px[i + 3] = x < width / 2 ? 255 : 0; // right half transparent
    }
  }
  return sharp(px, { raw: { width, height, channels } });
}

export async function pixelAt(image: Buffer, x: number, y: number): Promise<RGB> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

export function closeTo(actual: RGB, expected: RGB, tolerance = 40): boolean {
  return actual.every((v, i) => Math.abs(v - expected[i]!) <= tolerance);
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    TEMP_DIR: path.join(os.tmpdir(), `imageresizer-test-${process.pid}`),
    RATE_LIMIT_MAX: '1000',
    ...overrides,
  });
}

export class ScratchDir {
  dir = '';
  async setup() {
    this.dir = await mkdtemp(path.join(os.tmpdir(), 'ir-scratch-'));
  }
  async write(name: string, data: Buffer | string) {
    const p = path.join(this.dir, name);
    await writeFile(p, data);
    return p;
  }
  async cleanup() {
    await rm(this.dir, { recursive: true, force: true });
  }
}
