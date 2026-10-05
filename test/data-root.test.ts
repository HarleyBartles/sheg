import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDataRoot } from '../src/infrastructure/data-root.js';

test('an explicit Sheg data directory takes precedence over plugin and OS storage', () => {
  assert.equal(resolveDataRoot({ SHEG_DATA_DIR: 'D:\\ShegRuns', PLUGIN_DATA: 'D:\\Plugin' }, 'win32', 'C:\\Users\\reader'), 'D:\\ShegRuns');
  assert.equal(resolveDataRoot({ SHEG_DATA_DIR: '/data/sheg', PLUGIN_DATA: '/data/plugin' }, 'linux', '/home/reader'), '/data/sheg');
});

test('plugin hosts use the same platform data directory as standalone callers', () => {
  assert.equal(resolveDataRoot({ PLUGIN_DATA: 'D:\\Plugin' }, 'win32', 'C:\\Users\\reader'), 'C:\\Users\\reader\\AppData\\Local\\Sheg');
  assert.equal(resolveDataRoot({ PLUGIN_DATA: '/plugin' }, 'darwin', '/Users/reader'), '/Users/reader/Library/Application Support/Sheg');
  assert.equal(resolveDataRoot({ PLUGIN_DATA: '/plugin', XDG_DATA_HOME: '/var/data' }, 'linux', '/home/reader'), '/var/data/sheg');
});

test('standalone installations resolve to each platform application data directory', () => {
  assert.equal(resolveDataRoot({}, 'win32', 'C:\\Users\\reader'), 'C:\\Users\\reader\\AppData\\Local\\Sheg');
  assert.equal(resolveDataRoot({ LOCALAPPDATA: 'D:\\Profiles\\reader\\Local' }, 'win32', 'C:\\Users\\reader'), 'D:\\Profiles\\reader\\Local\\Sheg');
  assert.equal(resolveDataRoot({}, 'darwin', '/Users/reader'), '/Users/reader/Library/Application Support/Sheg');
  assert.equal(resolveDataRoot({ XDG_DATA_HOME: '/var/data' }, 'linux', '/home/reader'), '/var/data/sheg');
  assert.equal(resolveDataRoot({}, 'linux', '/home/reader'), '/home/reader/.local/share/sheg');
});

test('explicit relative or empty data directory overrides fail instead of using the working directory', () => {
  assert.throws(() => resolveDataRoot({ SHEG_DATA_DIR: 'runs' }, 'win32', 'C:\\Users\\reader'), /absolute/i);
  assert.throws(() => resolveDataRoot({ SHEG_DATA_DIR: '' }, 'linux', '/home/reader'), /empty/i);
  assert.throws(() => resolveDataRoot({ LOCALAPPDATA: 'relative' }, 'win32', 'C:\\Users\\reader'), /absolute/i);
  assert.throws(() => resolveDataRoot({ XDG_DATA_HOME: '' }, 'linux', '/home/reader'), /empty/i);
});
