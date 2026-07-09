/* =========================================================
   SUPABASE CLIENT
   Loaded via CDN in index.html BEFORE this file:
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
   <script src="js/supabase-client.js"></script>
   <script src="js/auth.js"></script>
   <script src="js/database.js"></script>
   <script src="js/script.js"></script>
   ========================================================= */

(function () {
  'use strict';

  // TODO: replace with your project's values (Project Settings -> API).
  // The anon/public key is SAFE to expose in client-side code — it only
  // grants what your RLS policies allow. It is not a secret.
const SUPABASE_URL = 'https://nuqigrsrdjrxmyrcdvdw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im51cWlncnNyZGpyeG15cmNkdmR3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MzAyMTMsImV4cCI6MjA5OTEwNjIxM30.TID7FYelN5Vp676-tMJrK3fOmr25fzOdJuzE2y-F7Nc';

  if (!window.supabase) {
    console.error('Supabase SDK not loaded. Check the CDN <script> tag order in index.html.');
    return;
  }

  // Exposed globally as window.sb — every other file (auth.js, database.js,
  // script.js) talks to Supabase only through this single client instance.
  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
})();
