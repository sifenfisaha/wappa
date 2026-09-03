import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleLogger } from './logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function spyConsole() {
  return {
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
}

describe('consoleLogger', () => {
  it("defaults to 'info' and drops debug entries", () => {
    const spies = spyConsole();
    const log = consoleLogger();
    log.debug('quiet');
    log.info('hello');
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalledWith('hello');
  });

  it('respects the configured threshold', () => {
    const spies = spyConsole();
    const log = consoleLogger('error');
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledWith('d');
  });

  it('passes structured data through as a second argument', () => {
    const spies = spyConsole();
    const log = consoleLogger('debug');
    log.debug('with data', { a: 1 });
    log.warn('no data');
    expect(spies.debug).toHaveBeenCalledWith('with data', { a: 1 });
    expect(spies.warn).toHaveBeenCalledWith('no data');
  });
});
