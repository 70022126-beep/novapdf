import {
    BrowserRouter,
    Routes,
    Route,
} from "react-router-dom";

import {
    lazy,
    Suspense,
} from "react";

import Header from "./components/Header";
import Hero from "./components/Hero";
import Tools from "./components/Tools";
import Footer from "./components/Footer/Footer";


// ============================================
// CARGA DIFERIDA DE HERRAMIENTAS PDF
// ============================================

const MergePDF = lazy(() =>
    import("./pages/MergePDF/MergePDF")
);

const SplitPDF = lazy(() =>
    import("./pages/SplitPDF/SplitPDF")
);

const CompressPDF = lazy(() =>
    import("./pages/CompressPDF/CompressPDF")
);

const ConvertPDF = lazy(() =>
    import("./pages/ConvertPDF/ConvertPDF")
);
const PDFToWord = lazy(() =>
    import("./pages/PDFToWord/PDFToWord")
);
const PDFEngineInspector = lazy(() =>
    import("./pages/PDFEngineInspector/PDFEngineInspector")
);
const OCRTest = lazy(() =>
    import("./pages/OCRTest/OCRTest")
);

// ============================================
// PANTALLA DE CARGA
// ============================================

function LoadingPage() {
    return (
        <div className="app-loading">

            <div className="app-loading-icon">
                📄
            </div>

            <p>
                Cargando herramienta...
            </p>

        </div>
    );
}


// ============================================
// PÁGINA PRINCIPAL
// ============================================

function Home() {
    return (
        <>
            <Hero />

            <Tools />

            <Footer />
        </>
    );
}


// ============================================
// APP PRINCIPAL
// ============================================

function App() {
    return (
        <BrowserRouter
            future={{
                v7_startTransition: true,
                v7_relativeSplatPath: true,
            }}
        >

            <Header />

            <Suspense fallback={<LoadingPage />}>

                <Routes>

                    {/* =========================
                        INICIO
                    ========================= */}

                    <Route
                        path="/"
                        element={<Home />}
                    />


                    {/* =========================
                        UNIR PDF
                    ========================= */}

                    <Route
                        path="/merge-pdf"
                        element={<MergePDF />}
                    />


                    {/* =========================
                        DIVIDIR PDF
                    ========================= */}

                    <Route
                        path="/split-pdf"
                        element={<SplitPDF />}
                    />


                    {/* =========================
                        COMPRIMIR PDF
                    ========================= */}

                    <Route
                        path="/compress-pdf"
                        element={<CompressPDF />}
                    />


                    {/* =========================
                        CONVERTIR PDF
                    ========================= */}

                    <Route
                        path="/convert-pdf"
                        element={<ConvertPDF />}
                    />
                    <Route
                        path="/pdf-to-word"
                        element={<PDFToWord />}
                    />
                    <Route
                        path="/pdf-engine-inspector"
                        element={<PDFEngineInspector />}
                    />
                    <Route
                        path="/ocr-test"
                        element={<OCRTest />}
                    />
                </Routes>

            </Suspense>

        </BrowserRouter>
    );
}


export default App;
