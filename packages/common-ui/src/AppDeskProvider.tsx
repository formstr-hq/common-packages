import { useCallback, useRef, type ReactNode } from 'react';

import { AppDeskContext } from './appDeskContext';
import { SuiteDesk, type SuiteDeskHandle, type SuiteDeskProps } from './SuiteDesk';

export interface AppDeskProviderProps extends Omit<SuiteDeskProps, 'currentAppId'> {
  /** The product the host app is. Passed to every open() call. */
  currentAppId: string;
  children: ReactNode;
}

/**
 * Hosts the suite drawer once for an app and exposes `useAppDesk()` to open it
 * from a logo mark or an account-menu item.
 *
 * The provider is framework-agnostic. Pass the host's theme tokens through
 * `style` (see the README) so the drawer follows the app's scheme.
 */
export function AppDeskProvider({
  children,
  currentAppId,
  ...deskProps
}: AppDeskProviderProps) {
  const deskRef = useRef<SuiteDeskHandle>(null);

  const open = useCallback(
    (anchor: HTMLElement) => {
      deskRef.current?.open(anchor, currentAppId);
    },
    [currentAppId],
  );

  return (
    <AppDeskContext.Provider value={open}>
      {children}
      <SuiteDesk ref={deskRef} currentAppId={currentAppId} {...deskProps} />
    </AppDeskContext.Provider>
  );
}
