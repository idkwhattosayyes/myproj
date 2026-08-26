// Publishable key не секретный — доступ к данным защищён через RLS в Supabase
// (см. supabase/schema.sql). Значения совпадают с .env — браузер .env напрямую
// читать не может (нет сборщика), поэтому переносим их сюда вручную.
export const SUPABASE_URL = "https://aivtrswpvnzqfrycxhru.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_6ty7Uhkrv0LbOP3gN231lQ_x4QeSsdv";
