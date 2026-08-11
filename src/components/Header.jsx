import "./Header.css";

function Header() {
  return (
    <header className="header">

      <div className="logo">
        <span className="logo-icon">📄</span>
        <span className="logo-text">NovaPDF</span>
      </div>

      <nav className="menu">
        <a href="#">Inicio</a>
        <a href="#">Herramientas</a>
        <a href="#">Precios</a>
        <a href="#">Contacto</a>
      </nav>

      <button className="login-btn">
        Iniciar sesión
      </button>

    </header>
  );
}

export default Header;