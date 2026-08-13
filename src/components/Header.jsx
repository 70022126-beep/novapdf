import "./Header.css";
import { Link, useNavigate } from "react-router-dom";

function Header() {
    const navigate = useNavigate();

    const irAHerramientas = () => {
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

            <Link
                to="/"
                className="logo"
            >
                <span className="logo-icon">
                    📄
                </span>

                <span className="logo-text">
                    NovaPDF
                </span>
            </Link>

            <nav className="menu">

                <button
    type="button"
    onClick={() => {
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
    }}
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

                <Link to="/">
                    Precios
                </Link>

                <Link to="/">
                    Contacto
                </Link>

            </nav>

            <button className="login-btn">
                Iniciar sesión
            </button>

        </header>
    );
}

export default Header;