import "./App.css";

function App() {
  return (
    <div className="app">
      <header className="navbar">
        <div className="logo">
          📄 <span>NovaPDF</span>
        </div>

        <nav>
          <a href="#">Inicio</a>
          <a href="#">Herramientas</a>
          <a href="#">Precios</a>
          <a href="#">Contacto</a>
        </nav>

        <button className="btn-login">
          Iniciar sesión
        </button>
      </header>

      <main className="hero">

        <span className="badge">
          🚀 Plataforma moderna para documentos
        </span>

        <h1>
          Todas tus herramientas PDF
          <br />
          en un solo lugar
        </h1>

        <p>
          Une, divide, comprime, convierte y administra
          tus documentos de forma rápida y segura.
        </p>

        <button className="btn-primary">
          Comenzar gratis
        </button>

      </main>
    </div>
  );
}

export default App;