import "./ToolCard.css";

function ToolCard({ icon, title, description, onClick }) {
  return (
    <div className="tool-card">

      <div className="tool-icon">
        {icon}
      </div>

      <h3>{title}</h3>

      <p>{description}</p>

      <button onClick={onClick}>
        Abrir
      </button>

    </div>
  );
}

export default ToolCard;