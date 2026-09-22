import { Platform } from "react-native";

/**
 * Server address configuration:
 * - Android Emulator uses 10.0.2.2 to reach host machine
 * - iOS Simulator and Web use 127.0.0.1
 * - Real devices use your computer's LAN IP (e.g. 192.168.1.50)
 */
export const SERVER_URL =
  Platform.OS === "android" ? "http://10.0.2.2:3000" : "http://127.0.0.1:3000";

export const CLIENT_KEY = "fk_clt_development_public_key";
