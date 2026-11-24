// Se importa antes que cada función: entrega createClient a los módulos remotos (motor.ts, app-api.ts, hs-sync.ts)
import { createClient } from "npm:@supabase/supabase-js@2";
(globalThis as any).__gvCreateClient = createClient;
