import { createContext, useContext } from 'react';

export type OpenAppDesk = (anchor: HTMLElement) => void;

export const AppDeskContext = createContext<OpenAppDesk>(() => {});

/** Open the suite drawer anchored to an element — usually the avatar/menu trigger. */
export function useAppDesk(): OpenAppDesk {
  return useContext(AppDeskContext);
}
