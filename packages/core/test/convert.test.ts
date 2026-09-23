import { describe, expect, it } from 'vitest';
import { convertValue, parseDate, parseNumber } from '../src';

const page = 'https://shop.test/c/shoes';

describe('value conversion', () => {
  it('parses the first numeric token', () => {
    expect(convertValue('number', '$1,299.00', page)).toBe(1299);
    expect(parseNumber('Rated 4.5 out of 5')).toBe(4.5);
    expect(parseNumber('-12 degrees')).toBe(-12);
    expect(parseNumber('free')).toBeNull();
  });

  it('resolves relative URLs against the page URL', () => {
    expect(convertValue('url', '/p/42', page)).toBe('https://shop.test/p/42');
    expect(convertValue('image', 'img/a.png', page)).toBe('https://shop.test/c/img/a.png');
    expect(convertValue('url', 'https://other.test/x', page)).toBe('https://other.test/x');
    expect(convertValue('url', '  ', page)).toBeNull();
  });

  it('collapses whitespace in text', () => {
    expect(convertValue('text', '\n  Wireless \t  Mouse \n', page)).toBe('Wireless Mouse');
  });

  it('trims html', () => {
    expect(convertValue('html', '  <b>x</b>\n', page)).toBe('<b>x</b>');
  });

  it('parses ISO and the listed date formats', () => {
    expect(convertValue('date', '2024-03-05', page)).toBe('2024-03-05');
    expect(convertValue('date', '2024-03-05T10:20:30Z', page)).toBe('2024-03-05T10:20:30.000Z');
    expect(parseDate('03/05/2024')).toBe('2024-03-05');
    expect(parseDate('05.03.2024')).toBe('2024-03-05');
    expect(parseDate('March 5, 2024')).toBe('2024-03-05');
    expect(parseDate('5 Mar 2024')).toBe('2024-03-05');
  });

  it('falls back to raw text for unparseable dates', () => {
    expect(convertValue('date', ' last   Tuesday ', page)).toBe('last Tuesday');
    expect(convertValue('date', '2024-02-30', page)).toBe('2024-02-30');
  });
});
