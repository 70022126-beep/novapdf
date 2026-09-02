import "./Hero.css";

export default function Hero() {
  const irAHerramientas = () => {
    document
      .getElementById("herramientas")
      ?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <section className="hero">

      <div className="badge">
        🚀 Plataforma profesional para documentos
      </div>

      <h1>
        Todas tus herramientas PDF
        <br />
        en un solo lugar
      </h1>

      <p>
        Une, divide, comprime, convierte y administra
        tus documentos de manera rápida, segura y profesional.
      </p>

      <button type="button" onClick={irAHerramientas}>
        Comenzar gratis
      </button>

    </section>
  );
}