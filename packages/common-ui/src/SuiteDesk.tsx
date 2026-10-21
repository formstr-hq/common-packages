import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { Asterisk } from './Asterisk';
import { APP_MARKS } from './marks';
import { APPS, type FormstrApp, type FormstrAppId } from './registry';

export interface SuiteDeskProps {
  /** Public product list. Defaults to the suite registry. */
  apps?: readonly FormstrApp[];
  /** The product the user is in. Marked in the drawer. */
  currentAppId?: FormstrAppId | string;
  theme?: 'auto' | 'light' | 'dark';
  /** Called before an app link navigates. Call `preventDefault()` for native. */
  onNavigate?: (app: FormstrApp, event: MouseEvent<HTMLAnchorElement>) => void;
  /** Small heading above the grid. Defaults to "Apps". */
  title?: string;
  /** Host theme tokens. The drawer follows the app instead of carrying its own palette. */
  className?: string;
  style?: CSSProperties;
}

export interface SuiteDeskHandle {
  /** Open the drawer anchored to an element — usually the hidden mark in a logo. */
  open: (anchor: HTMLElement, appId?: string) => void;
  close: () => void;
}

interface Position {
  left: number;
  top: number;
  above: boolean;
  caret: number;
}

export const SuiteDesk = forwardRef<SuiteDeskHandle, SuiteDeskProps>(function SuiteDesk(
  {
    apps = APPS as readonly FormstrApp[],
    currentAppId,
    theme = 'auto',
    onNavigate,
    title = 'Apps',
    className,
    style,
  },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [activeAppId, setActiveAppId] = useState<string | undefined>(currentAppId);
  const [position, setPosition] = useState<Position | null>(null);
  const [socialOpen, setSocialOpen] = useState(false);

  const anchorRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const socialId = `${panelId}-social`;

  const currentId = activeAppId ?? currentAppId;
  const appTiles = apps.filter((app) => app.group === 'apps');
  const community = apps.filter((app) => app.group === 'community');
  const currentIsCommunity = community.some((app) => app.id === currentId);

  useEffect(() => {
    if (currentIsCommunity) setSocialOpen(true);
  }, [currentIsCommunity]);

  const close = useCallback((restoreFocus = false) => {
    const previous = anchorRef.current;
    setOpen(false);
    setAnchor(null);
    setPosition(null);
    anchorRef.current = null;
    if (restoreFocus && previous?.isConnected) previous.focus({ preventScroll: true });
  }, []);

  const openDesk = useCallback(
    (nextAnchor: HTMLElement, appId?: string) => {
      if (open && anchorRef.current === nextAnchor) {
        close();
        return;
      }
      anchorRef.current = nextAnchor;
      setAnchor(nextAnchor);
      setActiveAppId(appId ?? currentAppId);
      setOpen(true);
    },
    [close, currentAppId, open],
  );

  useImperativeHandle(ref, () => ({ open: openDesk, close: () => close() }), [close, openDesk]);

  useLayoutEffect(() => {
    if (!open || !anchor) return;

    const update = () => {
      const panel = panelRef.current;
      if (!panel) return;

      if (window.innerWidth < 640) {
        setPosition(null);
        return;
      }

      const margin = 12;
      const a = anchor.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      let left = a.left + a.width / 2 - p.width / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - p.width - margin));

      let top = a.bottom + 14;
      let above = false;
      if (top + p.height > window.innerHeight - margin) {
        top = a.top - p.height - 14;
        above = true;
      }
      top = Math.max(margin, top);

      setPosition({ left, top, above, caret: a.left + a.width / 2 - left });
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor, open]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [close, open]);

  if (!open || typeof document === 'undefined') return null;

  const panelStyle: CSSProperties = {
    ...(position
      ? {
          left: position.left,
          top: position.top,
          '--fs-desk-caret': `${position.caret}px`,
        }
      : {}),
    ...style,
  } as CSSProperties;

  const inkStyle = (app: FormstrApp): CSSProperties =>
    ({
      '--fs-app-ink': app.ink.light,
      '--fs-app-ink-dark': app.ink.dark,
    }) as CSSProperties;

  const appTile = (app: FormstrApp, sub = false) => (
    <a
      key={app.id}
      className={sub ? 'fs-desk__subitem' : 'fs-desk__tile'}
      style={inkStyle(app)}
      href={app.url}
      data-current={app.id === currentId ? 'true' : undefined}
      aria-current={app.id === currentId ? 'page' : undefined}
      onClick={(event) => onNavigate?.(app, event)}
    >
      <span className="fs-desk__icon" aria-hidden="true">
        {APP_MARKS[app.id]}
      </span>
      {sub ? (
        <span className="fs-desk__subtext">
          <span className="fs-desk__label">{app.label}</span>
          {app.tag && <span className="fs-desk__subtag">{app.tag}</span>}
        </span>
      ) : (
        <span className="fs-desk__label">{app.label}</span>
      )}
    </a>
  );

  const drawer = (
    <div
      id={panelId}
      ref={panelRef}
      className={`fs-desk${position ? (position.above ? ' fs-desk--above' : ' fs-desk--below') : ''}${
        className ? ` ${className}` : ''
      }`}
      data-theme={theme}
      role="dialog"
      aria-label="App desk"
      tabIndex={-1}
      style={panelStyle}
    >
      <span className="fs-desk__caret" aria-hidden="true" />

      <div className="fs-desk__head">
        <Asterisk className="fs-desk__head-mark" size={14} strokeWidth={2.2} pulse />
        <span>{title}</span>
      </div>

      <div className="fs-desk__grid">
        {appTiles.map((app) => appTile(app))}

        {community.length > 0 && (
          <button
            type="button"
            className="fs-desk__tile fs-desk__tile--group"
            style={inkStyle(community[0])}
            data-current={currentIsCommunity ? 'true' : undefined}
            aria-expanded={socialOpen}
            aria-controls={socialId}
            onClick={() => setSocialOpen((value) => !value)}
          >
            <span className="fs-desk__icon" aria-hidden="true">
              {APP_MARKS[community[0].id]}
            </span>
            <span className="fs-desk__label">{community[0].tag ?? 'Social'}</span>
            <span className="fs-desk__chevron" aria-hidden="true">
              ›
            </span>
          </button>
        )}
      </div>

      {community.length > 0 && socialOpen && (
        <div className="fs-desk__subgrid" id={socialId}>
          {community.map((app) => appTile(app, true))}
        </div>
      )}
    </div>
  );

  return createPortal(drawer, document.body);
});
