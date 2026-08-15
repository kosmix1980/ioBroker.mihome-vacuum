// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            email: string;
            password: string;
            server: string;
            token: string;
            ip: string;
            model: string;
            manager: string;
            lib: string;
            enableMiMap: boolean;
            enableSelfCommands: boolean;
            sendPauseBeforeHome: boolean;
            enableResumeZone: boolean;
            port: number;
            ownPort: number;
            pingInterval: number;
            wifiInterval: number;
            valetudo_enable: boolean;
            valetudo_color_floor: string;
            valetudo_color_wall: string;
            valetudo_color_path: string;
            robot_select: string;
            valetudo_requestIntervall: number;
            valetudo_MapsaveIntervall: number;
            newmap: boolean;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
