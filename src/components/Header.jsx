import "./Header.css";
import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";

function Header() {
    const navigate = useNavigate();

    const [menuOpen, setMenuOpen] = useState(false);

    const cerrarMenu = () => {
        setMenuOpen(false);
    };

    const irAInicio = () => {
        cerrarMenu();

        if (window.location.pathname !== "/") {
            navigate("/");

            setTimeout(() => {
                window.scrollTo({
                    top: 0,
                    behavior: "smooth",
                });
            }, 100);
        } else {
            window.scrollTo({
                top: 0,
                behavior: "smooth",
            });
        }
    };

    const irAHerramientas = () => {
        cerrarMenu();

        if (window.location.pathname !== "/") {
            navigate("/");

            setTimeout(() => {
                document
                    .getElementById("herramientas")
                    ?.scrollIntoView({
                        behavior: "smooth",
                    });
            }, 100);
        } else {
            document
                .getElementById("herramientas")
                ?.scrollIntoView({
                    behavior: "smooth",
                });
        }
    };

    return (
        <header className="header">

            {/* LOGO */}

            <Link
                to="/"
                className="logo"
                onClick={cerrarMenu}
            >
                <span className="logo-icon">
                    📄
                </span>

                <span className="logo-text">
                    NovaPDF
                </span>
            </Link>


            {/* BOTÓN MENÚ MÓVIL */}

            <button
                type="button"
                className="mobile-menu-button"
                onClick={() => setMenuOpen(!menuOpen)}
                aria-label={
                    menuOpen
                        ? "Cerrar menú"
                        : "Abrir menú"
                }
                aria-expanded={menuOpen}
            >
                {menuOpen ? "✕" : "☰"}
            </button>


            {/* MENÚ */}

            <nav
                className={`menu ${
                    menuOpen ? "menu-open" : ""
                }`}
            >

                <button
                    type="button"
                    onClick={irAInicio}
                    className="menu-link-button"
                >
                    Inicio
                </button>


                <button
                    type="button"
                    onClick={irAHerramientas}
                    className="menu-link-button"
                >
                    Herramientas
                </button>


                <Link
                    to="/"
                    onClick={cerrarMenu}
                >
                    Precios
                </Link>


                <Link
                    to="/"
                    onClick={cerrarMenu}
                >
                    Contacto
                </Link>


                {/* LOGIN EN MENÚ MÓVIL */}

                <button
                    type="button"
                    className="mobile-login-btn"
                    onClick={cerrarMenu}
                >
                    Iniciar sesión
                </button>

            </nav>


            {/* LOGIN DESKTOP */}

            <button
                type="button"
                className="login-btn"
            >
                Iniciar sesión
            </button>

        </header>
    );
}

export default Header;