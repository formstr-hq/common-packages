import { Capacitor } from "@capacitor/core";

/**
 * Detects if the app is running in a Capacitor native environment.
 */
export const isNative = Capacitor.isNativePlatform();

/**
 * Detects if the app is running on Android (Native).
 */
export const isAndroidNative = (): boolean => {
  return Capacitor.getPlatform() === "android";
};

/**
 * Detects if the app is running on iOS (Native).
 */
export const isIOSNative = (): boolean => {
  return Capacitor.getPlatform() === "ios";
};

/**
 * Detects if the environment is a mobile browser (non-native).
 */
export const isMobileBrowser = (): boolean => {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
};
