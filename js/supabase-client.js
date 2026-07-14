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

  const SUPABASE_URL = 'https://ansrfmbvfjddyyymi.supabase.co';

  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFucnNyZm1idmZqZGR5eXNpeW1pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMTcxOTYsImV4cCI6MjA5OTU5MzE5Nn0.PLmql4AwybrOBCH9A30-uR25XH8j3COCcr9JYFpYY34';

  if (!window.supabase) {
    console.error('Supabase SDK not loaded. Check the CDN <script> tag order in index.html.');
    return;
  }

  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
})();