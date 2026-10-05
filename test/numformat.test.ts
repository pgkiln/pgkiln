// Number format masks (src/numformat.ts): formatting like Oracle's TO_CHAR,
// the separators of each language, parsing typed numbers back, mask errors.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compileMask, decText, EN_SYMBOLS, formatNumber, isPlainNumber, maskError, numberSymbols, parseNumber, roundDec, toDec } from '../src/numformat.ts';

const en = EN_SYMBOLS;
const de = numberSymbols('de', 'EUR');
const nl = numberSymbols('nl', 'EUR');
const fr = numberSymbols('fr', 'EUR');
const es = numberSymbols('es', 'EUR');

const cases = (sym: typeof en, list: [unknown, string, string | undefined][]) => {
  for (const [value, mask, want] of list) assert.equal(formatNumber(value, mask, sym), want, `${mask} on ${JSON.stringify(value)}`);
};

describe('number symbols per language', () => {
  test('group and decimal separators come from Intl; the currency symbol from the ISO code', () => {
    assert.deepEqual({ ...numberSymbols('en', 'USD') }, { group: ',', decimal: '.', currency: '$', iso: 'USD' });
    assert.equal(de.group, '.');
    assert.equal(de.decimal, ',');
    assert.equal(nl.group, '.');
    assert.equal(nl.decimal, ',');
    assert.equal(es.decimal, ',');
    assert.equal(fr.decimal, ',');
    assert.match(fr.group, /^[\s  ]$/);
    assert.equal(de.currency, '€');
    assert.equal(numberSymbols('en-GB', 'GBP').currency, '£');
    assert.equal(numberSymbols('en', 'JPY').currency, '¥');
  });
  test('an unknown language or currency falls back without throwing', () => {
    assert.equal(numberSymbols('xx-invalid-!!', 'USD').decimal, '.');
    assert.equal(numberSymbols('en', 'ZZZ').currency.length > 0, true);
  });
});

describe('decimal strings', () => {
  test('toDec reads numbers, bigints and Postgres numeric text', () => {
    assert.deepEqual(toDec('1234.5600'), { neg: false, int: '1234', frac: '5600' });
    assert.deepEqual(toDec('-0.05'), { neg: true, int: '', frac: '05' });
    assert.deepEqual(toDec(1e21), { neg: false, int: '1000000000000000000000', frac: '' });
    assert.deepEqual(toDec(1.5e-7), { neg: false, int: '', frac: '00000015' });
    assert.deepEqual(toDec(12n), { neg: false, int: '12', frac: '' });
    assert.deepEqual(toDec('-0'), { neg: false, int: '', frac: '' });
    assert.deepEqual(toDec('.5'), { neg: false, int: '', frac: '5' });
    for (const bad of ['', 'abc', '1.2.3', '1e', '--1', NaN, Infinity, null, undefined, {}, true, '.'])
      assert.equal(toDec(bad), null, String(bad));
  });
  test('rounding is half away from zero and exact', () => {
    const r = (v: string, n: number) => decText(roundDec(toDec(v)!, n));
    assert.equal(r('1.005', 2), '1.01');
    assert.equal(r('2.675', 2), '2.68'); // 2.675 is 2.67499… as a double
    assert.equal(r('-2.5', 0), '-3');
    assert.equal(r('0.4', 0), '0');
    assert.equal(r('-0.4', 0), '0');
    assert.equal(r('9.995', 2), '10');
    assert.equal(r('999.9999', 3), '1000');
    assert.equal(r('123456789012345678901234567890.125', 2), '123456789012345678901234567890.13');
    assert.equal(roundDec(toDec('1.5')!, 3).frac, '500');
  });
});

describe('formatting fixed-point masks', () => {
  test('groups and decimals in English', () => {
    cases(en, [
      [1234567.891, '999G999G990D00', '1,234,567.89'],
      ['1234567.891', '999,999,990.00', '1,234,567.89'],
      [0, '999G990D00', '0.00'],
      [0.5, '999G990D00', '0.50'],
      [12, '999G990D00', '12.00'],
      [1234, '9G999', '1,234'],
      [123, '9G999', '123'],
      [-1234.5, '999G990D00', '-1,234.50'],
      [1234.5, '9999', '1235'],
      [-0.004, '990D00', '0.00'],
      ['99999999999999999999999.5', '999999999999999999999999', '100000000000000000000000'],
    ]);
  });
  test('the separators follow the language (G and D), "," and "." stay fixed', () => {
    cases(de, [
      [1234567.891, '999G999G990D00', '1.234.567,89'],
      [1234567.891, '999,999,990.00', '1,234,567.89'],
      [0.25, '990D00', '0,25'],
    ]);
    cases(nl, [[1234.5, '9G990D00', '1.234,50']]);
    cases(es, [[1234.5, '9G990D00', '1.234,50']]);
    assert.equal(formatNumber(1234.5, '9G990D00', fr), `1${fr.group}234,50`);
  });
  test('9 leaves out leading zeros, 0 keeps them from its position on', () => {
    cases(en, [
      [5, '0000', '0005'],
      [5, '9099', '005'],
      [5, '9909', '05'],
      [0, '999', '0'],
      [0.5, '999D99', '.50'],
      [0.5, '990D99', '0.50'],
      [0.5, 'D99', '.50'],
      [7, '000G000', '000,007'],
      [12345, '000G000', '012,345'],
    ]);
  });
  test('fraction digits: without FM all places show, with FM trailing 9s are dropped', () => {
    cases(en, [
      [1.5, '999D99', '1.50'],
      [1.5, 'FM999D99', '1.5'],
      [5, 'FM999D99', '5'],
      [1.5, 'FM999D00', '1.50'],
      [1.5, 'FM999D0099', '1.50'],
      [1.5, 'FM999D0009', '1.500'],
      [1.50001, 'FM999D0099', '1.50'],
      [1.2345, 'FM999D0099', '1.2345'],
      [0, 'FM999D99', '0'],
      [0.1, 'FM990D99', '0.1'],
    ]);
  });
  test('too many digits for the mask shows #', () => {
    cases(en, [
      [12345, '999', '####'],
      [10000, '9G999', '#'.repeat(6)],
      [1000, '9G999', '1,000'],
      [999.995, '990D00', '#'.repeat(7)],
      [-12345, '999', '####'],
    ]);
  });
  test('signs: default minus, S first or last, MI and PR', () => {
    cases(en, [
      [-5, '999', '-5'],
      [5, 'S999', '+5'],
      [-5, 'S999', '-5'],
      [5, '999S', '5+'],
      [-5, '999S', '5-'],
      [-5, '999MI', '5-'],
      [5, '999MI', '5'],
      [-5, '999PR', '<5>'],
      [5, '999PR', '5'],
      [-1234.5, 'L9G990D00PR', '<$1,234.50>'],
      [-1234.5, '9G990D00LMI', '1,234.50$-'],
      [-0.001, 'S990D00', '+0.00'],
    ]);
  });
  test('currency: L (symbol), C (ISO code), U, $, in front or behind', () => {
    cases(en, [
      [1234.5, 'FML999G990D00', '$1,234.50'],
      [-1234.5, 'FML999G990D00', '-$1,234.50'],
      [1234.5, 'C999G990D00', 'USD1,234.50'],
      [1234.5, '$9G990D00', '$1,234.50'],
      [1234.5, 'U9G990D00', '$1,234.50'],
    ]);
    cases(de, [
      [1234.5, '999G990D00L', '1.234,50€'],
      [1234.5, '999G990D00 L', '1.234,50 €'],
      [1234.5, '999G990D00" "C', '1.234,50 EUR'],
      [-1234.5, 'L999G990D00', '-€1.234,50'],
    ]);
    assert.equal(formatNumber(10, 'L990', numberSymbols('en-GB', 'GBP')), '£10');
  });
  test('percent and literal text are shown as they are', () => {
    cases(en, [
      [12.5, '990D0%', '12.5%'],
      [12.5, '990D0 %', '12.5 %'],
      [0.5, '990D00"pct"', '0.50pct'],
      [3, '"No. "990', 'No. 3'],
    ]);
    cases(nl, [[12.5, '990D0%', '12,5%']]);
  });
  test('B blanks a zero value; V multiplies by 10^n', () => {
    cases(en, [
      [0, 'B999', ''],
      [0.001, 'B990D00', ''],
      [5, 'B999', '5'],
      [0.5, 'B990D00', '.50'],
      [1.5, '99V99', '150'],
      [1.234, '99V9', '12'],
      [-1.5, '99V99', '-150'],
      [123.45, '99V99', '#'.repeat(6)],
    ]);
  });
  test('scientific notation (EEEE)', () => {
    cases(en, [
      [1234, '9D99EEEE', '1.23E+03'],
      [0.000123, '9D99EEEE', '1.23E-04'],
      [9.999, '9D99EEEE', '1.00E+01'],
      [-1234, '9D99EEEE', '-1.23E+03'],
      [0, '9D99EEEE', '0.00E+00'],
      [5, '9EEEE', '5E+00'],
      ['1e120', '9D9EEEE', '1.0E+120'],
    ]);
    cases(de, [[1234, '9D99EEEE', '1,23E+03']]);
  });
  test('hexadecimal, Roman numerals and TM', () => {
    cases(en, [
      [255, 'XXXX', 'FF'],
      [255, 'xxxx', 'ff'],
      [255, '0XXX', '00FF'],
      [255.6, 'XX', '#'.repeat(3)],
      [255.4, 'XX', 'FF'],
      [-1, 'XX', '###'],
      ['18446744073709551615', 'XXXXXXXXXXXXXXXX', 'FFFFFFFFFFFFFFFF'],
      [1987, 'RN', 'MCMLXXXVII'],
      [1987, 'FMrn', 'mcmlxxxvii'],
      [4, 'RN', 'IV'],
      [0, 'RN', '#'.repeat(15)],
      [4000, 'RN', '#'.repeat(15)],
      ['123.4500', 'TM', '123.45'],
      ['-0.5', 'TM9', '-0.5'],
      [1234, 'TME', '1.234E+03'],
    ]);
    cases(de, [['123.45', 'TM', '123,45']]);
  });
  test('masks are case-insensitive except for rn and x', () => {
    cases(en, [[1234.5, 'fml999g990d00', '$1,234.50'], [-5, '999mi', '5-']]);
  });
  test('values that are not numbers, and masks that are not valid, give undefined', () => {
    for (const v of ['abc', null, undefined, '', 'NaN', Infinity, {}]) assert.equal(formatNumber(v, '999', en), undefined);
    assert.equal(formatNumber(5, 'abc', en), undefined);
    assert.equal(formatNumber(5, '', en), undefined);
  });
});

describe('mask errors', () => {
  test('valid masks', () => {
    for (const m of ['999G999G990D00', 'FML999G990D00', '0000', 'S9990D0', '990D0%', '9D99EEEE', 'XXXX', '0XXX', 'RN', 'FMRN', 'TM', 'TM9', 'TME',
      'B999', '99V99', '999MI', '999PR', '999S', 'C999', '$999', '999G990D00 L', '"EUR "990D00', 'D99', '.99'])
      assert.equal(maskError(m), null, m);
  });
  test('masks that are not valid explain why', () => {
    const bad: [string, RegExp][] = [
      ['', /empty/],
      ['abc', /not a number format element/],
      ['G999', /digits to its left/],
      ['99G', /followed by a digit/],
      ['9D9G9', /left of the decimal/],
      ['9D9D9', /only one decimal/],
      ['99V9D9', /only one decimal/],
      ['S999S', /only one of S, MI and PR/],
      ['999MIPR', /only one of S, MI and PR|last element/],
      ['MI999', /last element/],
      ['9S99', /first or the last/],
      ['LC999', /only one currency/],
      ['9%9', /digits must be together/],
      ['999FM', /FM must come first/],
      ['RN9', /RN stands alone/],
      ['TM9 9', /TM stands alone/],
      ['X0X', /zeros in a hexadecimal/],
      ['X9', /only X and leading 0/],
      ['9G9EEEE', /group separators/],
      ['99D9EEEE', /exactly one digit/],
      ['L', /no digits/],
      ['"abc', /not closed/],
      ['9'.repeat(65), /longer than 64/],
      ['999B', /before the digits/],
    ];
    for (const [m, re] of bad) assert.match(maskError(m) ?? 'valid', re, m);
  });
  test('compiled masks are cached', () => {
    assert.equal(compileMask('999G990D00'), compileMask('999G990D00'));
  });
});

describe('parsing typed numbers (number items)', () => {
  test('English and German separators', () => {
    assert.equal(parseNumber('1,234.5', '999G990D00', en), '1234.5');
    assert.equal(parseNumber('1234.5', '999G990D00', en), '1234.5');
    assert.equal(parseNumber('1.234,50', '999G990D00', de), '1234.5');
    assert.equal(parseNumber('1234,5', '999G990D00', de), '1234.5');
    assert.equal(parseNumber('0,25', '990D00', nl), '0.25');
    assert.equal(parseNumber(',25', '990D00', nl), '0.25');
    assert.equal(parseNumber('1.234.567', '999G999G990', es), '1234567');
  });
  test('a group separator in the wrong place is an error, not a different number', () => {
    // "1.5" can't be German grouping: it is read as a plain number, like a dynamic action sets it
    assert.equal(parseNumber('1.5', '999G990D00', de), '1.5');
    assert.equal(parseNumber('1234.5', '999G990D00', de), '1234.5');
    assert.equal(parseNumber('1.500', '999G990D00', de), '1500');
    assert.equal(parseNumber('1.5,5', '999G990D00', de), null);
    assert.equal(parseNumber('1,5', '999G990D00', en), null);
    assert.equal(parseNumber('12,34.5', '999G990D00', en), null);
    assert.equal(parseNumber('1,234,5', '999G990D00', en), null);
  });
  test('French group separators: any kind of space', () => {
    assert.equal(parseNumber('1 234,5', '999G990D00', fr), '1234.5');
    assert.equal(parseNumber('1 234,5', '999G990D00', fr), '1234.5');
    assert.equal(parseNumber('1 234 567,5', '999G999G990D00', fr), '1234567.5');
    assert.equal(parseNumber('12 34,5', '999G990D00', fr), null);
  });
  test('currency, percent, literal text and spaces around the number are ignored', () => {
    assert.equal(parseNumber('$1,234.50', 'FML999G990D00', en), '1234.5');
    assert.equal(parseNumber('USD 1,234.50', 'C999G990D00', en), '1234.5');
    assert.equal(parseNumber('1.234,50 €', '999G990D00 L', de), '1234.5');
    assert.equal(parseNumber('1.234,50 eur', '999G990D00C', de), '1234.5');
    assert.equal(parseNumber('12,5 %', '990D0%', nl), '12.5');
    assert.equal(parseNumber('No. 3', '"No. "990', en), '3');
    assert.equal(parseNumber('  42  ', '999', en), '42');
  });
  test('signs: leading or trailing minus, plus, <PR> and (accounting)', () => {
    assert.equal(parseNumber('-5', '999', en), '-5');
    assert.equal(parseNumber('+5', 'S999', en), '5');
    assert.equal(parseNumber('5-', '999MI', en), '-5');
    assert.equal(parseNumber('<5>', '999PR', en), '-5');
    assert.equal(parseNumber('(1,234.50)', '999G990D00', en), '-1234.5');
    assert.equal(parseNumber('- $1,234.50', 'L999G990D00', en), '-1234.5');
    assert.equal(parseNumber('-0', '999', en), '0');
    assert.equal(parseNumber('--5', '999', en), null);
    assert.equal(parseNumber('-5-', '999', en), null);
    assert.equal(parseNumber('<-5>', '999PR', en), null);
  });
  test('V divides again; EEEE, TM, X and RN read their own notation', () => {
    assert.equal(parseNumber('150', '99V99', en), '1.5');
    assert.equal(parseNumber('5', '99V99', en), '0.05');
    assert.equal(parseNumber('1.23E+03', '9D99EEEE', en), '1230');
    assert.equal(parseNumber('1,23E+03', '9D99EEEE', de), '1230');
    assert.equal(parseNumber('123,45', 'TM', de), '123.45');
    assert.equal(parseNumber('ff', 'XXXX', en), '255');
    assert.equal(parseNumber('zz', 'XXXX', en), null);
    assert.equal(parseNumber('mcmlxxxvii', 'RN', en), '1987');
    assert.equal(parseNumber('IIII', 'RN', en), null);
  });
  test('empty input is empty; text that is not a number is null', () => {
    assert.equal(parseNumber('', '999', en), '');
    assert.equal(parseNumber('   ', '999', en), '');
    for (const bad of ['abc', '1a', '1..2', '.', '-', '1e5', '12 34', 'x'.repeat(300), '1;drop table x'])
      assert.equal(parseNumber(bad, '999G990D00', en), null, bad);
  });
  test('without a valid mask the language separators are used', () => {
    assert.equal(parseNumber('1.234,5', null, de), '1234.5');
    assert.equal(parseNumber('1,234.5', 'not a mask', en), '1234.5');
  });
  test('round trip: what a mask shows reads back as the same number', () => {
    const masks = ['999G999G990D00', 'FML999G990D00', 'S9990D000', '990D0%', '999G990D00 L', 'C999G990D00', '999G990D00PR', '999G990D00MI', '0000'];
    const values = ['0', '1', '-1', '12.5', '-1234.56', '999999.99', '0.05'];
    for (const sym of [en, de, nl, fr, es])
      for (const mask of masks)
        for (const v of values) {
          const shown = formatNumber(v, mask, sym)!;
          if (shown.startsWith('#')) continue;
          const expected = decText(roundDec(toDec(v)!, (compileMask(mask) as { frac: string[] }).frac.length));
          assert.equal(parseNumber(shown, mask, sym), expected, `${mask} ${v} → ${shown}`);
        }
  });
  test('plain numbers (number items without a mask)', () => {
    for (const ok of ['1', '-1.5', '+2', '.5', '5.', '1e3', ' 12 ']) assert.equal(isPlainNumber(ok), true, ok);
    for (const bad of ['', 'abc', '1,5', '1.2.3', '1e', '--1', '1 2']) assert.equal(isPlainNumber(bad), false, bad);
  });
});
