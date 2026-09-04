import { useState } from "react";
import { supabase } from "./supabaseClient";

export default function Auth() {
  const [mode, setMode] = useState("signin"); // signin | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setMsg("");
    setLoading(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMsg("Cuenta creada. Si tu proyecto de Supabase requiere confirmar el email, revisa tu correo antes de entrar.");
      }
    } catch (err) {
      setMsg(err.message || "Ocurrió un error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <div style={styles.eyebrow}>BITÁCORA · PERSONAL</div>
        <h1 style={styles.title}>{mode === "signin" ? "Iniciar sesión" : "Crear cuenta"}</h1>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
          <input
            type="email" required placeholder="tu@email.com" value={email}
            onChange={(e) => setEmail(e.target.value)} style={styles.input}
          />
          <input
            type="password" required placeholder="Contraseña" value={password}
            onChange={(e) => setPassword(e.target.value)} style={styles.input}
          />
          <button type="submit" disabled={loading} style={styles.button}>
            {loading ? "Un momento…" : mode === "signin" ? "Entrar" : "Crear cuenta"}
          </button>
        </form>
        {msg && <div style={styles.msg}>{msg}</div>}
        <button
          onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setMsg(""); }}
          style={styles.link}
        >
          {mode === "signin" ? "¿No tienes cuenta? Créala aquí" : "¿Ya tienes cuenta? Inicia sesión"}
        </button>
      </div>
    </div>
  );
}

const styles = {
  wrap: {
    minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
    background: "#0B1220", fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
  },
  card: {
    width: 340, background: "#121B2E", border: "1px solid #20304C", borderRadius: 10, padding: 28,
    color: "#E7ECF5",
  },
  eyebrow: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: 2, color: "#E8A33D" },
  title: { fontSize: 20, fontWeight: 600, margin: "6px 0 0" },
  input: {
    background: "#0E1626", border: "1px solid #20304C", color: "#E7ECF5",
    borderRadius: 6, padding: "10px 12px", fontSize: 14, outline: "none",
  },
  button: {
    background: "#E8A33D", color: "#1A1300", border: "none", borderRadius: 6,
    padding: "10px 12px", fontWeight: 600, fontSize: 14, cursor: "pointer", marginTop: 4,
  },
  msg: { fontSize: 12, color: "#7E8CA6", marginTop: 12, lineHeight: 1.4 },
  link: {
    background: "none", border: "none", color: "#7E8CA6", fontSize: 12,
    marginTop: 16, cursor: "pointer", textDecoration: "underline", padding: 0,
  },
};
