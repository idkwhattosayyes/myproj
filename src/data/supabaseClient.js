// Единый клиент Supabase — им пользуется слой авторизации (src/auth/) и в
// будущем будет пользоваться Supabase-адаптер хранения (см. storageAdapter.js),
// поэтому клиент лежит здесь, а не внутри auth/.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../supabaseConfig.js";

// window.supabase — глобал из CDN-скрипта в index.html (подключён обычным
// <script>, не модулем, поэтому он гарантированно уже загружен к этому моменту).
export const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
