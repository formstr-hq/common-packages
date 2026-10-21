// @vitest-environment happy-dom
import { act, createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SuiteDesk, type SuiteDeskHandle } from '../src/SuiteDesk.js';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function openDesk(handle: SuiteDeskHandle | null, appId = 'pages') {
  const anchor = document.createElement('button');
  anchor.textContent = 'hidden mark';
  document.body.append(anchor);
  act(() => handle?.open(anchor, appId));
  return anchor;
}

describe('SuiteDesk', () => {
  it('opens a simple drawer of apps, anchored to the hidden mark', () => {
    const ref = createRef<SuiteDeskHandle>();
    render(<SuiteDesk ref={ref} currentAppId="pages" />);

    openDesk(ref.current);

    expect(screen.getByRole('dialog', { name: 'App desk' })).toBeTruthy();
    expect(screen.getByText('Apps')).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(5);
    expect(screen.getByRole('link', { name: 'Forms' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Mail' })).toBeTruthy();
    expect(screen.queryByText('Pulse')).toBeNull();
    expect(screen.queryByText('What do you want to do?')).toBeNull();
  });

  it('groups Pollerama and Standards under one Social icon', () => {
    const ref = createRef<SuiteDeskHandle>();
    render(<SuiteDesk ref={ref} currentAppId="pages" />);
    openDesk(ref.current);

    const social = screen.getByRole('button', { name: 'Social' });
    expect(social.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(social);

    expect(social.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('link')).toHaveLength(7);
    expect(screen.getByRole('link', { name: /Pollerama/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /NIPs/ })).toBeTruthy();
    expect(screen.getByText('Standards')).toBeTruthy();
  });

  it('expands Social automatically when a community app is current', () => {
    const ref = createRef<SuiteDeskHandle>();
    render(<SuiteDesk ref={ref} currentAppId="nips" />);
    openDesk(ref.current, 'nips');

    expect(screen.getAllByRole('link')).toHaveLength(7);
    const current = screen.getByRole('link', { name: /NIPs/ });
    expect(current.getAttribute('aria-current')).toBe('page');
  });

  it('marks the current product', () => {
    const ref = createRef<SuiteDeskHandle>();
    render(<SuiteDesk ref={ref} currentAppId="pages" />);
    openDesk(ref.current, 'pages');

    const current = screen.getByRole('link', { name: 'Pages' });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.getAttribute('data-current')).toBe('true');
  });

  it('closes on Escape and returns focus to the mark', () => {
    const ref = createRef<SuiteDeskHandle>();
    render(<SuiteDesk ref={ref} />);
    const anchor = openDesk(ref.current);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'App desk' })).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });

  it('calls onNavigate before following an app link', () => {
    const ref = createRef<SuiteDeskHandle>();
    let visited = '';
    render(<SuiteDesk ref={ref} onNavigate={(app) => (visited = app.id)} />);
    openDesk(ref.current);

    fireEvent.click(screen.getByRole('link', { name: 'Forms' }));

    expect(visited).toBe('forms');
  });

  it('accepts a custom title', () => {
    const ref = createRef<SuiteDeskHandle>();
    render(<SuiteDesk ref={ref} title="Formstr" />);
    openDesk(ref.current);

    expect(screen.getByText('Formstr')).toBeTruthy();
  });
});
