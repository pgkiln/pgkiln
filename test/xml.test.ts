// The XML reader for data loading (src/xml.ts): well-formedness, entities,
// limits, and the safety properties (no DTD, no external entities).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { scanXml, XmlError, xmlTable } from '../src/xml.ts';
import { LoadError, parseFile } from '../src/dataload.ts';

const EMP = `<?xml version="1.0" encoding="UTF-8"?>
<!-- an export -->
<hr:employees xmlns:hr="urn:example">
  <hr:employee id="7839" active="yes">
    <name>KING</name>
    <job>PRESIDENT</job>
    <hired>1981-11-17</hired>
    <address><city>Amsterdam</city><zip>1011</zip></address>
  </hr:employee>
  <hr:employee id="7698">
    <name>BLAKE &amp; Sons</name>
    <job><![CDATA[MANAGER <sales>]]></job>
    <note>caf&#233; &#x2603; &lt;ok&gt; &quot;q&quot; &apos;a&apos;</note>
  </hr:employee>
  <hr:employee id="7782"/>
</hr:employees>`;

describe('xmlTable', () => {
  test('rows from the repeating element (detected), attributes, children, nested paths, entities, CDATA', () => {
    const t = xmlTable(EMP);
    assert.equal(t.rowPath, 'employee');
    assert.deepEqual(t.headers, ['@id', '@active', 'name', 'job', 'hired', 'address/city', 'address/zip', 'note']);
    assert.deepEqual(t.rows, [
      ['7839', 'yes', 'KING', 'PRESIDENT', '1981-11-17', 'Amsterdam', '1011', null],
      ['7698', null, 'BLAKE & Sons', 'MANAGER <sales>', null, null, null, 'café ☃ <ok> "q" \'a\''],
      ['7782', null, null, null, null, null, null, null],
    ]);
  });

  test('a given row element or path', () => {
    const xml = '<r><meta><item>x</item></meta><data><item><v>1</v></item><item><v>2</v></item></data></r>';
    assert.deepEqual(xmlTable(xml, 'data/item').rows, [['1'], ['2']]);
    assert.deepEqual(xmlTable(xml, 'item'), { rowPath: 'item', headers: ['item', 'v'], rows: [['x', null], [null, '1'], [null, '2']] });
    assert.throws(() => xmlTable(xml, 'nothing'), /No <nothing> elements/);
    assert.throws(() => xmlTable(xml, 'a b'), XmlError);
  });

  test('text-only rows become one column', () => {
    assert.deepEqual(xmlTable('<names><name>Ann</name><name>Bob</name></names>'), { rowPath: 'name', headers: ['name'], rows: [['Ann'], ['Bob']] });
  });

  test('the row limit', () => {
    assert.throws(() => xmlTable('<a><b x="1"/><b x="2"/><b x="3"/></a>', null, { maxRows: 2 }), /more than 2 rows/);
  });
});

describe('XML safety', () => {
  const noop = { open() {}, text() {}, close() {} };

  test('a DOCTYPE is refused: no XXE, no entity expansion (billion laughs)', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>`;
    assert.throws(() => scanXml(xxe, noop), /document type declaration/);
    const laughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<lolz>&lol3;</lolz>`;
    assert.throws(() => scanXml(laughs, noop), /document type declaration/);
    assert.throws(() => scanXml('<!doctype r><r/>', noop), /document type declaration/);
    assert.throws(() => scanXml('<r><!ENTITY a "b"></r>', noop), /Unexpected "<!"/);
  });

  test('undefined entities are errors, not expanded or fetched', () => {
    assert.throws(() => scanXml('<r>&xxe;</r>', noop), /Undefined entity &xxe;/);
    assert.throws(() => scanXml('<r a="&ext;"/>', noop), /Undefined entity/);
    assert.throws(() => scanXml('<r>a & b</r>', noop), /must start an entity/);
    assert.throws(() => scanXml('<r>&#0;</r>', noop), /Invalid character reference/);
    assert.throws(() => scanXml('<r>&#xD800;</r>', noop), /Invalid character reference/);
  });

  test('limits: depth, elements, attributes, names', () => {
    const deep = '<a>'.repeat(101) + '</a>'.repeat(101);
    assert.throws(() => scanXml(deep, noop), /nested deeper than 100/);
    assert.doesNotThrow(() => scanXml('<a>'.repeat(100) + '</a>'.repeat(100), noop));
    assert.throws(() => scanXml(`<r>${'<x/>'.repeat(11)}</r>`, noop, { maxElements: 10 }), /More than 10 elements/);
    const attrs = Array.from({ length: 257 }, (_, k) => `a${k}="1"`).join(' ');
    assert.throws(() => scanXml(`<r ${attrs}/>`, noop), /More than 256 attributes/);
    assert.throws(() => scanXml(`<${'n'.repeat(300)}/>`, noop), /longer than 256/);
  });

  test('well-formedness errors carry the line', () => {
    assert.throws(() => scanXml('<r>\n<a></b></r>', noop), /<\/b> does not close <a> \(line 2/);
    assert.throws(() => scanXml('<r>', noop), /<r> is not closed/);
    assert.throws(() => scanXml('<r/><s/>', noop), /Only one root element/);
    assert.throws(() => scanXml('text<r/>', noop), /Text before the root/);
    assert.throws(() => scanXml('<r a="1" a="2"/>', noop), /Duplicate attribute/);
    assert.throws(() => scanXml('<r a=1/>', noop), /must be quoted/);
    assert.throws(() => scanXml('<r a="<"/>', noop), /not allowed in an attribute/);
    assert.throws(() => scanXml('', noop), /no root element/);
    assert.throws(() => scanXml('<r><!-- x </r>', noop), /Unterminated comment/);
  });
});

describe('parseFile with XML', () => {
  test('detected by name or content; the row element can be given', async () => {
    const s = await parseFile('emp.xml', Buffer.from(EMP));
    assert.equal(s.format, 'xml');
    assert.equal(s.rows.length, 3);
    const byContent = await parseFile('upload.bin', Buffer.from(`﻿${EMP}`));
    assert.equal(byContent.format, 'xml');
    const given = await parseFile('x.txt', Buffer.from('<a><b><c>1</c></b></a>'), { format: 'xml', rowTag: 'b' });
    assert.deepEqual(given.rows, [['1']]);
  });

  test('XML errors become load errors', async () => {
    await assert.rejects(parseFile('x.xml', Buffer.from('<!DOCTYPE x><x/>')), (e) => e instanceof LoadError && /document type declaration/.test(e.message));
  });
});
