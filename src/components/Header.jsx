import "./Header.css";
import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";

function Header() {
    const navigate = useNavigate();

    const [menuOpen, setMenuOpen] = useState(false);

    // ============================================
    // CERRAR MENÚ
    // ============================================

    const cerrarMenu = () => {
        setMenuOpen(false);
    };


    // ============================================
    // IR A INICIO
    // ============================================

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


    // ============================================
    // IR A HERRAMIENTAS
    // ============================================

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


    // ============================================
    // IR A UNA HERRAMIENTA
    // ============================================

    const irAHerramienta = (ruta) => {
        cerrarMenu();

        navigate(ruta);
    };


    return (
        <header className="header">

            {/* ====================================
                LOGO
            ==================================== */}

            <Link
                to="/"
                className="logo"
                onClick={cerrarMenu}
                aria-label="NovaPDF - Inicio"
            >
                <span className="logo-icon">
                    📄
                </span>

                <span className="logo-text">
                    NovaPDF
                </span>
            </Link>


            {/* ====================================
                BOTÓN MENÚ MÓVIL
            ==================================== */}

            <button
                type="button"
                className="mobile-menu-button"
                onClick={() =>
                    setMenuOpen((estadoActual) => !estadoActual)
                }
                aria-label={
                    menuOpen
                        ? "Cerrar menú"
                        : "Abrir menú"
                }
                aria-expanded={menuOpen}
                aria-controls="menu-principal"
            >
                {menuOpen ? "✕" : "☰"}
            </button>


            {/* ====================================
                MENÚ
            ==================================== */}

            <nav
                id="menu-principal"
                className={`menu ${
                    menuOpen ? "menu-open" : ""
                }`}
                aria-label="Navegación principal"
            >

                {/* INICIO */}

                <button
                    type="button"
                    onClick={irAInicio}
                    className="menu-link-button"
                >
                    Inicio
                </button>


                {/* HERRAMIENTAS */}

                <button
                    type="button"
                    onClick={irAHerramientas}
                    className="menu-link-button"
                >
                    Herramientas
                </button>


                {/* PRECIOS */}

                <Link
                    to="/"
                    onClick={cerrarMenu}
                >
                    Precios
                </Link>


                {/* CONTACTO */}

                <Link
                    to="/"
                    onClick={cerrarMenu}
                >
                    Contacto
                </Link>


                {/* =================================
                    LOGIN MÓVIL
                ================================= */}

                <button
                    type="button"
                    className="mobile-login-btn"
                    onClick={cerrarMenu}
                >
                    Iniciar sesión
                </button>

            </nav>


            {/* ====================================
                LOGIN DESKTOP
            ==================================== */}

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