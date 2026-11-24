// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  createModalFocus,
  type ModalFocusController,
  type ModalFocusOptions,
} from './modal-focus';

const controllers: ModalFocusController[] = [];

function makeController(options: ModalFocusOptions): ModalFocusController {
  const controller = createModalFocus(options);
  controllers.push(controller);
  return controller;
}

function must<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`missing fixture element: ${selector}`);
  }
  return element;
}

interface Fixture {
  readonly header: HTMLElement;
  readonly main: HTMLElement;
  readonly modal: HTMLElement;
  readonly opener: HTMLButtonElement;
}

function mount(modalContent: string): Fixture {
  document.body.innerHTML = `
    <header id="header"><a id="brand" href="#home">brand</a></header>
    <main id="main"><button id="opener" type="button">open</button></main>
    <div id="modal" role="dialog" aria-modal="true">
      ${modalContent}
    </div>
  `;
  return {
    header: must<HTMLElement>('#header'),
    main: must<HTMLElement>('#main'),
    modal: must<HTMLElement>('#modal'),
    opener: must<HTMLButtonElement>('#opener'),
  };
}

const THREE_BUTTONS = `
  <button id="again" type="button">再来一局</button>
  <button id="lobby" type="button">返回大厅</button>
  <button id="close" type="button">关闭</button>
`;

function pressTab(shiftKey = false): KeyboardEvent {
  const focused = document.activeElement;
  const target = focused instanceof HTMLElement ? focused : document.body;
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.close();
  }
  document.body.replaceChildren();
});

describe('createModalFocus', () => {
  it('打开时聚焦传入的初始元素', () => {
    const fixture = mount(THREE_BUTTONS);
    const controller = makeController({
      container: fixture.modal,
      initialFocus: must('#again'),
    });

    fixture.opener.focus();
    controller.open();

    expect(controller.isOpen()).toBe(true);
    expect(document.activeElement).toBe(must('#again'));
  });

  it('未指定初始元素时聚焦容器内第一个可聚焦元素', () => {
    const fixture = mount(THREE_BUTTONS);
    const controller = makeController({ container: fixture.modal });

    controller.open();

    expect(document.activeElement).toBe(must('#again'));
  });

  it('Tab 在多个可聚焦元素间正向循环，并在末尾回到开头', () => {
    const fixture = mount(THREE_BUTTONS);
    const controller = makeController({
      container: fixture.modal,
      initialFocus: must('#again'),
    });
    controller.open();

    const first = pressTab();
    expect(first.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(must('#lobby'));

    pressTab();
    expect(document.activeElement).toBe(must('#close'));

    const wrapped = pressTab();
    expect(wrapped.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(must('#again'));
  });

  it('Shift+Tab 反向循环，并在开头回到末尾', () => {
    const fixture = mount(THREE_BUTTONS);
    const controller = makeController({
      container: fixture.modal,
      initialFocus: must('#again'),
    });
    controller.open();

    const wrapped = pressTab(true);
    expect(wrapped.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(must('#close'));

    pressTab(true);
    expect(document.activeElement).toBe(must('#lobby'));

    pressTab(true);
    expect(document.activeElement).toBe(must('#again'));
  });

  it('只有一个可聚焦元素时 Tab 与 Shift+Tab 都停在它上面', () => {
    const fixture = mount('<button id="again" type="button">再来一局</button>');
    const controller = makeController({
      container: fixture.modal,
      initialFocus: must('#again'),
    });
    controller.open();

    const forward = pressTab();
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(must('#again'));

    const backward = pressTab(true);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(must('#again'));
  });

  it('焦点不在容器内时 Tab 进入首尾两端', () => {
    const fixture = mount(THREE_BUTTONS);
    const controller = makeController({
      container: fixture.modal,
      initialFocus: must('#again'),
    });
    controller.open();

    fixture.opener.focus();
    pressTab();
    expect(document.activeElement).toBe(must('#again'));

    fixture.opener.focus();
    pressTab(true);
    expect(document.activeElement).toBe(must('#close'));
  });

  it('跳过 disabled、hidden、aria-hidden 与负 tabindex 的元素', () => {
    const fixture = mount(`
      <button id="again" type="button">再来一局</button>
      <button id="disabled" type="button" disabled>停用</button>
      <button id="hidden" type="button" hidden>隐藏</button>
      <button id="aria" type="button" aria-hidden="true">读屏隐藏</button>
      <button id="trap" type="button" tabindex="-1">不可 Tab</button>
      <button id="close" type="button">关闭</button>
    `);
    const controller = makeController({
      container: fixture.modal,
      initialFocus: must('#again'),
    });
    controller.open();

    expect(controller.focusables().map((element) => element.id)).toEqual([
      'again',
      'close',
    ]);

    pressTab();
    expect(document.activeElement).toBe(must('#close'));

    pressTab();
    expect(document.activeElement).toBe(must('#again'));
  });

  it('打开时给背景元素加 inert，关闭时移除', () => {
    const fixture = mount(THREE_BUTTONS);
    const controller = makeController({
      container: fixture.modal,
      initialFocus: must('#again'),
      background: [fixture.header, fixture.main],
    });

    fixture.opener.focus();
    controller.open();
    expect(fixture.header.hasAttribute('inert')).toBe(true);
    expect(fixture.main.hasAttribute('inert')).toBe(true);

    controller.close();
    expect(fixture.header.hasAttribute('inert')).toBe(false);
    expect(fixture.main.hasAttribute('inert')).toBe(false);
  });

  it('关闭时把焦点还给打开前的元素', () => {
    const fixture = mount(THREE_BUTTONS);
    const controller = makeController({
      container: fixture.modal,
      initialFocus: must('#again'),
    });

    fixture.opener.focus();
    controller.open();
    expect(document.activeElement).toBe(must('#again'));

    controller.close();
    expect(controller.isOpen()).toBe(false);
    expect(document.activeElement).toBe(fixture.opener);
  });

  it('重新打开会记录新的焦点位置', () => {
    const fixture = mount(THREE_BUTTONS);
    const controller = makeController({
      container: fixture.modal,
      initialFocus: must('#again'),
    });

    fixture.opener.focus();
    controller.open();
    controller.close();
    expect(document.activeElement).toBe(fixture.opener);

    must<HTMLButtonElement>('#lobby').focus();
    controller.open();
    controller.close();
    expect(document.activeElement).toBe(must('#lobby'));
  });

  it('重复关闭是幂等的，并停止拦截 Tab', () => {
    const fixture = mount(THREE_BUTTONS);
    const controller = makeController({
      container: fixture.modal,
      initialFocus: must('#again'),
      background: [fixture.header],
    });

    fixture.opener.focus();
    controller.open();
    controller.close();
    expect(controller.isOpen()).toBe(false);
    expect(fixture.header.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(fixture.opener);

    expect(() => controller.close()).not.toThrow();
    expect(controller.isOpen()).toBe(false);
    expect(fixture.header.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(fixture.opener);

    must<HTMLButtonElement>('#again').focus();
    const event = pressTab();
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(must('#again'));
  });
});
