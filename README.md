# Motor de cadencias · GeoVictoria

Código del motor de envíos (función `cadencias` de Supabase). La función desplegada importa `motor.ts`
desde este repositorio por commit fijo, así:

```ts
// index.ts
import "./dep.ts";   // entrega createClient en globalThis.__gvCreateClient
import "https://raw.githubusercontent.com/geo-victoria/cadencias-motor/<commit>/motor.ts";
```

```ts
// dep.ts
import { createClient } from "npm:@supabase/supabase-js@2";
(globalThis as any).__gvCreateClient = createClient;
```

No contiene claves: todas viven como secretos de Supabase (variables de entorno).
