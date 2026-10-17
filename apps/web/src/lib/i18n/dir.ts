import type { Locale } from "./config";

/**
 * Returns the text direction for a locale.
 * RTL languages: Arabic, Hebrew (not in our set yet), Persian, Urdu.
 */
export function dir(locale: Locale): "rtl" | "ltr" {
  switch (locale) {
    case "ar":
      return "rtl";
    default:
      return "ltr";
  }
}
