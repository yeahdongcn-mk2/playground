// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { escapeHtml, query } from './dom';
import { isEditableTarget as isEditableTargetFromInput } from './input';

describe('escapeHtml', () => {
  it('escapes the five HTML-sensitive characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
    expect(escapeHtml('普通文本')).toBe('普通文本');
  });
});

describe('query', () => {
  it('returns the first matching element and throws for missing elements', () => {
    document.body.innerHTML = '<div class="a">first</div><div class="a">second</div>';
    expect(query<HTMLElement>(document, '.a').textContent).toBe('first');
    expect(() => query(document, '.missing')).toThrow('Expected element not found: .missing');
  });
});

describe('isEditableTarget', () => {
  it('ignores form fields and editors but not buttons or the body', () => {
    const input = document.createElement('input');
    const button = document.createElement('button');
    expect(isEditableTargetFromInput(input)).toBe(true);
    expect(isEditableTargetFromInput(button)).toBe(false);
    expect(isEditableTargetFromInput(document.body)).toBe(false);
    expect(isEditableTargetFromInput(null)).toBe(false);
  });
});
