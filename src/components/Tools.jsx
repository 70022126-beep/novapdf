import "./Tools.css";
import { useNavigate } from "react-router-dom";
import ToolCard from "./ToolCard/ToolCard";

function Tools() {
  const navigate = useNavigate();

  const tools = [
    {
      icon: "📄",
      title: "Unir PDF",
      description: "Combina varios archivos PDF en uno solo.",
      route: "/merge-pdf",
    },
    {
      icon: "✂️",
      title: "Dividir PDF",
      description: "Extrae páginas de un documento.",
      route: "/split-pdf",
    },
    {
      icon: "📦",
      title: "Comprimir PDF",
      description: "Reduce el tamaño de tus PDF.",
      route: "/compress-pdf",
    },
  ];

  return (
    <section className="tools">
      <h2>Herramientas más utilizadas</h2>

      <p>
        Selecciona una herramienta para comenzar.
      </p>

      <div className="tools-grid">
        {tools.map((tool) => (
          <ToolCard
            key={tool.title}
            icon={tool.icon}
            title={tool.title}
            description={tool.description}
            onClick={() => navigate(tool.route)}
          />
        ))}
      </div>
    </section>
  );
}

export default Tools;