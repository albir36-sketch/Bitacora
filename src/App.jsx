import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import Auth from "./Auth";
import Dashboard from "./Dashboard";

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = loading, null = logged out

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => listener.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <div style={{ minHeight: "100vh", background: "#0B1220", color: "#7E8CA6", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "monospace" }}>
        Cargando…
      </div>
    );
  }

  return session ? <Dashboard session={session} /> : <Auth />;
}
