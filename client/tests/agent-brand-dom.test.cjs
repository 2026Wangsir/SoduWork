'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const brand = require('../components/panels/agent-brand');

class Element {
  constructor(tag, namespace) { this.tag = tag; this.namespace = namespace; this.attributes = {}; this.children = []; this.textContent = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...children) { this.children.push(...children); }
}
const document = {
  createElement: tag => new Element(tag),
  createElementNS: (namespace, tag) => new Element(tag, namespace),
};

test('DOM and HTML consumers use the same built-in runtime identity without an image registry', () => {
  for (const [id, mark] of Object.entries(brand.MONOGRAMS)) {
    const icon = brand.element({ key: 'runner:local:' + id }, { document, className: 'runtime-brand', id: 'current-runtime' });
    assert.equal(icon.attributes['data-agent-brand'], id);
    assert.equal(icon.attributes['aria-label'], brand.LABELS[id]);
    assert.equal(icon.attributes.title, brand.LABELS[id]);
    assert.equal(icon.attributes.role, 'img');
    assert.equal(icon.attributes.id, 'current-runtime');
    assert.equal(icon.attributes.class, brand.className(id, 'runtime-brand'));
    assert.equal(icon.children.length, 1);
    assert.equal(icon.children[0].attributes.class, 'agent-monogram');
    assert.equal(icon.children[0].attributes['aria-hidden'], 'true');
    assert.equal(icon.children[0].textContent, mark);
    assert.ok(brand.html(id).includes('>' + mark + '</span>'));
  }
});

test('unknown runtime DOM uses the same generic vector as HTML without parsing input as markup', () => {
  const input = '<img src=x onerror=alert(1)>', title = '\"<img src=x>';
  const icon = brand.element(input, { document, title });
  assert.equal(icon.attributes['data-agent-brand'], 'custom');
  assert.equal(icon.attributes.title, title);
  assert.equal(icon.children.length, 1);
  const svg = icon.children[0];
  assert.equal(svg.tag, 'svg');
  assert.equal(svg.namespace, 'http://www.w3.org/2000/svg');
  assert.equal(svg.attributes.viewBox, '0 0 24 24');
  assert.equal(svg.children.length, 2);
  for (const path of svg.children) {
    assert.equal(path.tag, 'path');
    assert.ok(brand.glyph(input).includes('d="' + path.attributes.d + '"'));
  }
  assert.doesNotMatch(brand.html(input, { title }), /<img/);
});
