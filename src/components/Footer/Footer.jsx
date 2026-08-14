import "./Footer.css";
import { Link, useNavigate } from "react-router-dom";

function Footer() {
    const navigate = useNavigate();

    const irAInicio = () => {
        navigate("/");

        setTimeout(() => {
            window.scrollTo({
                top: 0,
                behavior: "smooth",
            });
        }, 100);
    };

    const irAHerramientas = () => {
        navigate("/");

        setTimeout(() => {
            document
                .getElementById("herramientas")
                ?.scrollIntoView({
                    behavior: "smooth",
                });
        }, 100);
    };

    return (
        <footer className="footer">

            <div className="footer-container">

                {/* MARCA */}

                <div className="footer-brand">

                    <button
                        type="button"
                        className="footer-logo"
                        onClick={irAInicio}
                    >
                        <span className="footer-logo-icon">
                            📄
                        </span>

                        <span className="footer-logo-text">
                            NovaPDF
                        </span>
                    </button>

                    <p>
                        Herramientas PDF rápidas,
                        seguras y profesionales.
                    </p>

                </div>


                {/* HERRAMIENTAS */}

                <div className="footer-column">

                    <h3>
                        Herramientas
                    </h3>

                    <button
                        type="button"
                        onClick={() =>
                            navigate("/merge-pdf")
                        }
                    >
                        Unir PDF
                    </button>

                    <button
                        type="button"
                        onClick={() =>
                            navigate("/split-pdf")
                        }
                    >
                        Dividir PDF
                    </button>

                    <button
                        type="button"
                        onClick={() =>
                            navigate("/compress-pdf")
                        }
                    >
                        Comprimir PDF
                    </button>

                    <button
                        type="button"
                        onClick={() =>
                            navigate("/convert-pdf")
                        }
                    >
                        Convertir PDF
                    </button>

                </div>


                {/* NOVAPDF */}

                <div className="footer-column">

                    <h3>
                        NovaPDF
                    </h3>

                    <button
                        type="button"
                        onClick={irAInicio}
                    >
                        Inicio
                    </button>

                    <button
                        type="button"
                        onClick={irAHerramientas}
                    >
                        Herramientas
                    </button>

                    <Link to="/">
                        Precios
                    </Link>

                    <Link to="/">
                        Contacto
                    </Link>

                </div>

            </div>


            {/* PARTE INFERIOR */}

            <div className="footer-bottom">

                <p>
                    © 2026 NovaPDF. Todos los derechos
                    reservados.
                </p>

                <span>
                    Hecho para trabajar mejor con tus documentos.
                </span>

            </div>

        </footer>
    );
}

export default Footer;