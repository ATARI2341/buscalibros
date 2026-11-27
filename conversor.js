(function () {
    'use strict';

    const CONVERSIONES = {
        pdf: [
            { destino: 'txt', etiqueta: 'Texto (.txt)' },
            { destino: 'epub', etiqueta: 'EPUB (.epub)' }
        ],
        epub: [
            { destino: 'txt', etiqueta: 'Texto (.txt)' },
            { destino: 'pdf', etiqueta: 'PDF (.pdf)' }
        ],
        docx: [
            { destino: 'txt', etiqueta: 'Texto (.txt)' }
        ],
        txt: [
            { destino: 'epub', etiqueta: 'EPUB (.epub)' }
        ]
    };

    const RUTA_JSZIP = './vendor/jszip/3.10.1/jszip.min.js';
    const RUTA_JSPDF = './vendor/jspdf/4.2.1/jspdf.umd.min.js';
    const RUTA_PDFJS = new URL('./vendor/pdfjs/4.10.38/pdf.min.mjs', document.baseURI).href;
    const RUTA_WORKER = new URL('./vendor/pdfjs/4.10.38/pdf.worker.min.mjs', document.baseURI).href;
    const LIMITE_BYTES = 50 * 1024 * 1024;

    const SALTOS_XHTML = {
        p: '\n\n', div: '\n', h1: '\n\n', h2: '\n\n', h3: '\n\n', h4: '\n\n',
        h5: '\n\n', h6: '\n\n', li: '\n', tr: '\n', section: '\n\n',
        article: '\n\n', blockquote: '\n\n', pre: '\n\n', br: '\n'
    };

    const scriptsCargados = new Map();
    let promesaPdfjs = null;
    let archivoSeleccionado = null;
    let cancelado = false;
    let ultimoUrl = null;

    function porId(id) {
        return document.getElementById(id);
    }

    function escapeHtml(texto) {
        return String(texto == null ? '' : texto)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escaparXml(texto) {
        return escapeHtml(texto);
    }

    function notificar(mensaje, tipo) {
        if (typeof buscador !== 'undefined' && buscador && typeof buscador.mostrarNotificacion === 'function') {
            buscador.mostrarNotificacion(mensaje, tipo || 'info');
        } else {
            console.log(mensaje);
        }
    }

    function obtenerExtension(nombre) {
        const parte = String(nombre || '');
        const punto = parte.lastIndexOf('.');
        return punto === -1 ? '' : parte.slice(punto + 1).toLowerCase();
    }

    function nombreBase(nombre) {
        const parte = String(nombre || 'archivo');
        const punto = parte.lastIndexOf('.');
        return punto <= 0 ? parte : parte.slice(0, punto);
    }

    function formatearTamano(bytes) {
        if (!bytes) return '0 B';
        const unidades = ['B', 'KB', 'MB', 'GB'];
        const indice = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), unidades.length - 1);
        return (bytes / Math.pow(1024, indice)).toFixed(indice === 0 ? 0 : 1) + ' ' + unidades[indice];
    }

    function cargarScript(ruta) {
        if (scriptsCargados.has(ruta)) {
            return scriptsCargados.get(ruta);
        }
        const promesa = new Promise(function (resolve, reject) {
            const script = document.createElement('script');
            script.src = ruta;
            script.onload = resolve;
            script.onerror = function () {
                reject(new Error('No se pudo cargar la librería: ' + ruta));
            };
            document.head.appendChild(script);
        });
        scriptsCargados.set(ruta, promesa);
        return promesa;
    }

    function cargarPdfjs() {
        if (!promesaPdfjs) {
            promesaPdfjs = import(RUTA_PDFJS).then(function (pdfjsLib) {
                pdfjsLib.GlobalWorkerOptions.workerSrc = RUTA_WORKER;
                return pdfjsLib;
            });
        }
        return promesaPdfjs;
    }

    function comprobarCancelacion() {
        if (cancelado) {
            const error = new Error('Conversión cancelada por el usuario');
            error.name = 'ConversionCancelada';
            throw error;
        }
    }

    function actualizarProgreso(porcentaje, texto) {
        porId('barraConversion').style.width = Math.max(0, Math.min(100, porcentaje)) + '%';
        porId('estadoConversion').textContent = texto;
    }

    function cederTurno() {
        return new Promise(function (resolve) {
            setTimeout(resolve, 0);
        });
    }

    function limpiarResultado() {
        if (ultimoUrl) {
            URL.revokeObjectURL(ultimoUrl);
            ultimoUrl = null;
        }
        porId('resultadoConversion').classList.add('hidden');
        porId('resultadoConversion').innerHTML = '';
    }

    function actualizarFormatosDestino() {
        limpiarResultado();
        archivoSeleccionado = porId('archivoConversion').files[0] || null;

        const zona = porId('zonaArrastre');
        const textoZona = porId('textoZonaArrastre');
        if (zona) zona.classList.toggle('con-archivo', !!archivoSeleccionado);
        if (textoZona) {
            textoZona.textContent = archivoSeleccionado
                ? archivoSeleccionado.name
                : 'Arrastra tu archivo aquí o haz clic para seleccionarlo';
        }

        const select = porId('formatoDestino');
        const boton = porId('btnConvertir');
        const info = porId('conversionInfo');
        select.innerHTML = '';
        select.disabled = true;
        boton.disabled = true;
        info.classList.add('hidden');
        info.innerHTML = '';

        if (!archivoSeleccionado) {
            select.add(new Option('Sube un archivo primero', ''));
            return;
        }

        const extension = obtenerExtension(archivoSeleccionado.name);
        const opciones = CONVERSIONES[extension];

        if (!opciones || archivoSeleccionado.size > LIMITE_BYTES) {
            const mensaje = !opciones
                ? 'Formato no soportado. Sube un archivo PDF, EPUB, DOCX o TXT.'
                : 'El archivo supera el límite de 50 MB.';
            select.add(new Option('Sin conversiones disponibles', ''));
            info.innerHTML = '<strong>' + escapeHtml(mensaje) + '</strong>';
            info.classList.remove('hidden');
            notificar(mensaje, 'warning');
            return;
        }

        opciones.forEach(function (opcion) {
            select.add(new Option(opcion.etiqueta, opcion.destino));
        });
        select.disabled = false;
        boton.disabled = false;

        const destinos = opciones.map(function (opcion) {
            return opcion.destino.toUpperCase();
        }).join(', ');
        info.innerHTML = '<strong>Archivo detectado:</strong> ' + escapeHtml(archivoSeleccionado.name) +
            ' (' + extension.toUpperCase() + ', ' + formatearTamano(archivoSeleccionado.size) + ')' +
            '<small>Conversiones disponibles: ' + escapeHtml(destinos) + '</small>';
        info.classList.remove('hidden');
    }

    function cancelarConversion() {
        cancelado = true;
        actualizarProgreso(0, 'Cancelando conversión...');
    }

    async function leerBuffer(archivo, progreso) {
        progreso(5, 'Leyendo ' + archivo.name + '...');
        const buffer = await archivo.arrayBuffer();
        comprobarCancelacion();
        return buffer;
    }

    async function extraerPdf(buffer, progreso) {
        const pdfjsLib = await cargarPdfjs();
        progreso(15, 'Abriendo documento PDF...');
        const documento = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
        const partes = [];

        for (let numero = 1; numero <= documento.numPages; numero++) {
            comprobarCancelacion();
            const pagina = await documento.getPage(numero);
            const contenido = await pagina.getTextContent();
            let textoPagina = '';

            contenido.items.forEach(function (item) {
                textoPagina += item.str || '';
                if (item.hasEOL) textoPagina += '\n';
            });

            partes.push(textoPagina);
            progreso(15 + Math.round((numero / documento.numPages) * 70),
                'Procesando página ' + numero + ' de ' + documento.numPages);
            await cederTurno();
        }

        return partes.join('\n\n');
    }

    function parsearXml(texto) {
        const documento = new DOMParser().parseFromString(texto, 'application/xml');
        if (documento.getElementsByTagName('parsererror').length) {
            throw new Error('El archivo contiene XML inválido');
        }
        return documento;
    }

    async function leerEntradaZip(zip, ruta) {
        const entrada = zip.file(ruta) || zip.file(String(ruta).replace(/^\/+/, ''));
        return entrada ? await entrada.async('string') : null;
    }

    function resolverRuta(base, href) {
        const url = new URL(decodeURI(href), 'https://local.invalid/' + base);
        return decodeURIComponent(url.pathname.replace(/^\//, ''));
    }

    function textoDesdeXhtml(contenido) {
        let documento = new DOMParser().parseFromString(contenido, 'application/xhtml+xml');
        if (documento.getElementsByTagName('parsererror').length) {
            documento = new DOMParser().parseFromString(contenido, 'text/html');
        }
        const raiz = documento.getElementsByTagNameNS('*', 'body')[0] || documento.documentElement;
        const partes = [];
        recolectarXhtml(raiz, partes);
        return partes.join('');
    }

    function recolectarXhtml(nodo, salida) {
        if (!nodo) return;
        if (nodo.nodeType === 3) {
            salida.push(nodo.nodeValue || '');
            return;
        }
        if (nodo.nodeType !== 1) return;

        const local = (nodo.localName || nodo.tagName || '').toLowerCase();
        if (local === 'script' || local === 'style' || local === 'svg') return;
        if (local === 'br') {
            salida.push('\n');
            return;
        }

        nodo.childNodes.forEach(function (hijo) {
            recolectarXhtml(hijo, salida);
        });
        salida.push(SALTOS_XHTML[local] || '');
    }

    async function extraerEpub(buffer, progreso) {
        await cargarScript(RUTA_JSZIP);
        progreso(15, 'Leyendo estructura del EPUB...');
        const zip = new window.JSZip();
        await zip.loadAsync(buffer);

        const containerTexto = await leerEntradaZip(zip, 'META-INF/container.xml');
        if (!containerTexto) {
            throw new Error('El EPUB no contiene META-INF/container.xml');
        }

        const container = parsearXml(containerTexto);
        const archivoOpf = container.getElementsByTagName('rootfile')[0];
        let rutaOpf = archivoOpf ? archivoOpf.getAttribute('full-path') : null;
        if (!rutaOpf) {
            rutaOpf = Object.keys(zip.files).find(function (ruta) {
                return /\.opf$/i.test(ruta);
            });
        }
        if (!rutaOpf) {
            throw new Error('No se encontró el archivo OPF del EPUB');
        }
        rutaOpf = decodeURI(rutaOpf.trim());

        const opfTexto = await leerEntradaZip(zip, rutaOpf);
        const opf = parsearXml(opfTexto);
        const base = rutaOpf.indexOf('/') === -1 ? '' : rutaOpf.slice(0, rutaOpf.lastIndexOf('/') + 1);
        const manifiesto = new Map();

        Array.prototype.forEach.call(opf.getElementsByTagName('item'), function (item) {
            manifiesto.set(item.getAttribute('id'), item.getAttribute('href'));
        });

        let capitulos = Array.prototype.map.call(opf.getElementsByTagName('itemref'), function (referencia) {
            return manifiesto.get(referencia.getAttribute('idref'));
        }).filter(function (href) {
            return href && /\.(x?html|htm)$/i.test(href);
        });

        if (!capitulos.length) {
            capitulos = Object.keys(zip.files).filter(function (ruta) {
                return /\.(x?html|htm)$/i.test(ruta);
            }).sort();
        }

        const tituloNodo = opf.getElementsByTagName('dc:title')[0] ||
            opf.getElementsByTagNameNS('*', 'title')[0];
        const titulo = tituloNodo ? tituloNodo.textContent.trim() : '';
        const secciones = [];

        for (let indice = 0; indice < capitulos.length; indice++) {
            comprobarCancelacion();
            const ruta = capitulos[indice].indexOf('://') === -1
                ? resolverRuta(base, capitulos[indice])
                : capitulos[indice];
            const entrada = zip.file(ruta);
            if (entrada) {
                secciones.push(textoDesdeXhtml(await entrada.async('string')));
            }
            progreso(20 + Math.round((indice / capitulos.length) * 60),
                'Procesando capítulo ' + (indice + 1) + ' de ' + capitulos.length);
            await cederTurno();
        }

        return {
            texto: normalizarTexto(secciones.join('\n\n')),
            titulo: titulo
        };
    }

    function recolectarWord(nodo, salida) {
        if (!nodo) return;
        if (nodo.nodeType === 3) {
            salida.push(nodo.nodeValue || '');
            return;
        }
        if (nodo.nodeType !== 1) return;

        const local = (nodo.localName || nodo.tagName || '').toLowerCase();
        if (local === 't') {
            salida.push(nodo.textContent || '');
            return;
        }
        if (local === 'tab') {
            salida.push('\t');
            return;
        }
        if (local === 'br' || local === 'cr') {
            salida.push('\n');
            return;
        }

        nodo.childNodes.forEach(function (hijo) {
            recolectarWord(hijo, salida);
        });
    }

    async function extraerDocx(buffer, progreso) {
        await cargarScript(RUTA_JSZIP);
        progreso(15, 'Leyendo documento DOCX...');
        const zip = new window.JSZip();
        await zip.loadAsync(buffer);

        const xml = await leerEntradaZip(zip, 'word/document.xml');
        if (!xml) {
            throw new Error('El DOCX no contiene word/document.xml');
        }

        const documento = parsearXml(xml);
        const parrafos = Array.prototype.map.call(
            documento.getElementsByTagNameNS('*', 'p'),
            function (parrafo) {
                const partes = [];
                recolectarWord(parrafo, partes);
                return partes.join('').replace(/\s*\n\s*/g, ' ').replace(/ +/g, ' ').trim();
            }
        ).filter(function (linea) {
            return linea.length > 0;
        });

        progreso(85, 'Procesando ' + parrafos.length + ' párrafos...');
        await cederTurno();
        return parrafos.join('\n');
    }

    function normalizarTexto(texto) {
        return String(texto || '')
            .replace(/ /g, ' ')
            .replace(/[^\S\r\n\t]+/g, ' ')
            .replace(/ *\n */g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/^\s+|\s+$/g, '');
    }

    function dividirParrafos(texto) {
        const limpio = String(texto || '').replace(/\r\n/g, '\n').replace(/\f/g, '\n\n');
        let bloques = limpio.split(/\n\s*\n+/);
        if (bloques.length === 1) {
            bloques = limpio.split(/\n+/);
        }
        return bloques.map(function (bloque) {
            return bloque.replace(/[ \t]*\n[ \t]*/g, ' ').trim();
        }).filter(function (bloque) {
            return bloque.length > 0;
        });
    }

    function agruparCapitulos(parrafos) {
        const capitulos = [];
        let actuales = [];
        let longitud = 0;

        parrafos.forEach(function (parrafo) {
            if (actuales.length && (longitud + parrafo.length > 6000 || actuales.length >= 60)) {
                capitulos.push(actuales);
                actuales = [];
                longitud = 0;
            }
            actuales.push(parrafo);
            longitud += parrafo.length;
        });

        if (actuales.length) capitulos.push(actuales);
        if (!capitulos.length) capitulos.push(['']);
        return capitulos;
    }

    function generarUuid() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (caracter) {
            const aleatorio = Math.floor(Math.random() * 16);
            const valor = caracter === 'x' ? aleatorio : (aleatorio & 0x3) | 0x8;
            return valor.toString(16);
        });
    }

    async function crearEpub(parrafos, titulo, progreso) {
        await cargarScript(RUTA_JSZIP);
        progreso(85, 'Generando archivo EPUB...');
        const zip = new window.JSZip();
        const tituloSeguro = escaparXml(titulo || 'Documento convertido');
        const identificador = 'urn:uuid:' + generarUuid();
        const capitulos = agruparCapitulos(parrafos);

        zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
        zip.file('META-INF/container.xml',
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
            '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
            '</rootfiles></container>');

        const manifiesto = [
            '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
            '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
        ];
        const espina = [];
        const navPoints = [];
        const navItems = [];

        capitulos.forEach(function (parrafosCapitulo, indice) {
            const numero = indice + 1;
            const href = 'capitulo' + String(numero).padStart(3, '0') + '.xhtml';
            const id = 'cap' + numero;
            const etiqueta = 'Capítulo ' + numero;

            manifiesto.push('<item id="' + id + '" href="' + href + '" media-type="application/xhtml+xml"/>');
            espina.push('<itemref idref="' + id + '"/>');
            navItems.push('<li><a href="' + href + '">' + etiqueta + '</a></li>');
            navPoints.push('<navPoint id="np' + numero + '" playOrder="' + numero + '">' +
                '<navLabel><text>' + etiqueta + '</text></navLabel>' +
                '<content src="' + href + '"/></navPoint>');

            const cuerpo = parrafosCapitulo.map(function (parrafo) {
                return '<p>' + escaparXml(parrafo) + '</p>';
            }).join('\n');

            zip.file('OEBPS/' + href,
                '<?xml version="1.0" encoding="UTF-8"?>' +
                '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + etiqueta + '</title>' +
                '</head><body>' + cuerpo + '</body></html>');
        });

        zip.file('OEBPS/content.opf',
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="libro-id">' +
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
            '<dc:identifier id="libro-id">' + escaparXml(identificador) + '</dc:identifier>' +
            '<dc:title>' + tituloSeguro + '</dc:title>' +
            '<dc:language>es</dc:language>' +
            '<meta property="dcterms:modified">' + new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '</meta>' +
            '</metadata><manifest>' + manifiesto.join('') + '</manifest>' +
            '<spine toc="ncx">' + espina.join('') + '</spine></package>');

        zip.file('OEBPS/nav.xhtml',
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
            '<head><title>Índice</title></head><body><nav epub:type="toc"><h1>Índice</h1><ol>' +
            navItems.join('') + '</ol></nav></body></html>');

        zip.file('OEBPS/toc.ncx',
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head>' +
            '<meta name="dtb:uid" content="' + escaparXml(identificador) + '"/>' +
            '</head><docTitle><text>' + tituloSeguro + '</text></docTitle><navMap>' +
            navPoints.join('') + '</navMap></ncx>');

        return await zip.generateAsync({
            type: 'blob',
            mimeType: 'application/epub+zip',
            compression: 'DEFLATE'
        });
    }

    async function crearPdf(texto, titulo, progreso) {
        await cargarScript(RUTA_JSPDF);
        progreso(85, 'Generando archivo PDF...');
        const jsPDF = window.jspdf.jsPDF;
        const documento = new jsPDF({ unit: 'mm', format: 'a4' });
        const margen = 18;
        const ancho = 210 - margen * 2;
        const interlineado = 5.5;
        let y = margen;

        documento.setFont('helvetica', 'normal');
        documento.setFontSize(16);
        documento.text(titulo || 'Documento convertido', margen, y, { maxWidth: ancho });
        y += 12;

        documento.setFontSize(11);
        dividirParrafos(texto).forEach(function (parrafo) {
            const lineas = documento.splitTextToSize(parrafo, ancho);
            lineas.forEach(function (linea) {
                if (y > 297 - margen) {
                    documento.addPage();
                    y = margen;
                }
                documento.text(linea, margen, y);
                y += interlineado;
            });
            y += 2;
        });

        return documento.output('blob');
    }

    async function ejecutarConversion(origen, destino, archivo, progreso) {
        const buffer = await leerBuffer(archivo, progreso);

        if (origen === 'pdf' && destino === 'txt') {
            const texto = normalizarTexto(await extraerPdf(buffer, progreso));
            if (!texto) throw new Error('No se encontró texto en el PDF. ¿Es un archivo escaneado?');
            progreso(95, 'Preparando descarga...');
            return new Blob([texto], { type: 'text/plain;charset=utf-8' });
        }

        if (origen === 'pdf' && destino === 'epub') {
            const texto = normalizarTexto(await extraerPdf(buffer, progreso));
            if (!texto) throw new Error('No se encontró texto en el PDF. ¿Es un archivo escaneado?');
            return crearEpub(dividirParrafos(texto), nombreBase(archivo.name), progreso);
        }

        if (origen === 'epub' && destino === 'txt') {
            const resultado = await extraerEpub(buffer, progreso);
            if (!resultado.texto) throw new Error('No se encontró texto en el EPUB');
            progreso(95, 'Preparando descarga...');
            return new Blob([resultado.texto], { type: 'text/plain;charset=utf-8' });
        }

        if (origen === 'epub' && destino === 'pdf') {
            const resultado = await extraerEpub(buffer, progreso);
            if (!resultado.texto) throw new Error('No se encontró texto en el EPUB');
            return crearPdf(resultado.texto, resultado.titulo || nombreBase(archivo.name), progreso);
        }

        if (origen === 'docx' && destino === 'txt') {
            const texto = await extraerDocx(buffer, progreso);
            if (!texto) throw new Error('No se encontró texto en el DOCX');
            progreso(95, 'Preparando descarga...');
            return new Blob([texto], { type: 'text/plain;charset=utf-8' });
        }

        if (origen === 'txt' && destino === 'epub') {
            const texto = new TextDecoder('utf-8').decode(buffer).replace(/^\uFEFF/, '');
            comprobarCancelacion();
            const parrafos = dividirParrafos(texto);
            if (!parrafos.length) throw new Error('El archivo TXT está vacío');
            return crearEpub(parrafos, nombreBase(archivo.name), progreso);
        }

        throw new Error('Conversión no disponible: ' + origen + ' a ' + destino);
    }

    function mostrarResultado(nombre, tamano, url) {
        const contenedor = porId('resultadoConversion');
        contenedor.innerHTML = '<strong>✅ Conversión lista:</strong> ' + escapeHtml(nombre) +
            ' (' + formatearTamano(tamano) + ')<br>' +
            '<a href="' + url + '" download="' + escapeHtml(nombre) + '">⬇️ Descargar ' + escapeHtml(nombre) + '</a>';
        contenedor.classList.remove('hidden');
    }

    function dispararDescarga(url, nombre) {
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = nombre;
        enlace.style.display = 'none';
        document.body.appendChild(enlace);
        enlace.click();
        document.body.removeChild(enlace);
    }

    async function convertirArchivo() {
        if (!archivoSeleccionado) {
            notificar('Primero sube un archivo', 'warning');
            return;
        }

        const destino = porId('formatoDestino').value;
        if (!destino) {
            notificar('Elige un formato de destino', 'warning');
            return;
        }

        const archivo = archivoSeleccionado;
        const origen = obtenerExtension(archivo.name);

        limpiarResultado();
        cancelado = false;
        porId('progresoConversion').classList.remove('hidden');
        porId('btnCancelarConversion').classList.remove('hidden');
        porId('btnConvertir').disabled = true;
        porId('archivoConversion').disabled = true;
        porId('formatoDestino').disabled = true;
        actualizarProgreso(0, 'Preparando conversión...');

        const progreso = function (porcentaje, texto) {
            if (!cancelado) actualizarProgreso(porcentaje, texto);
        };

        try {
            const blob = await ejecutarConversion(origen, destino, archivo, progreso);
            comprobarCancelacion();

            const nombre = nombreBase(archivo.name) + '.' + destino;
            ultimoUrl = URL.createObjectURL(blob);
            mostrarResultado(nombre, blob.size, ultimoUrl);
            actualizarProgreso(100, 'Conversión completada');
            dispararDescarga(ultimoUrl, nombre);
            notificar('Convertido: ' + nombre, 'success');
        } catch (error) {
            if (error && error.name === 'ConversionCancelada') {
                actualizarProgreso(0, 'Conversión cancelada');
                notificar('Conversión cancelada', 'info');
            } else {
                console.error(error);
                actualizarProgreso(0, 'Error en la conversión');
                notificar('Error en la conversión: ' + escapeHtml(error.message || 'desconocido'), 'error');
            }
        } finally {
            porId('btnCancelarConversion').classList.add('hidden');
            porId('archivoConversion').disabled = false;
            porId('formatoDestino').disabled = false;
            porId('btnConvertir').disabled = false;
        }
    }

    function configurarZonaArrastre() {
        const zona = porId('zonaArrastre');
        const input = porId('archivoConversion');
        if (!zona || !input) return;

        zona.addEventListener('click', function (evento) {
            if (evento.target !== input) {
                input.click();
            }
        });

        zona.addEventListener('keydown', function (evento) {
            if (evento.key === 'Enter' || evento.key === ' ') {
                evento.preventDefault();
                input.click();
            }
        });

        ['dragenter', 'dragover'].forEach(function (tipo) {
            zona.addEventListener(tipo, function (evento) {
                evento.preventDefault();
                if (evento.dataTransfer) {
                    evento.dataTransfer.dropEffect = 'copy';
                }
                zona.classList.add('arrastrando');
            });
        });

        zona.addEventListener('dragleave', function (evento) {
            if (!zona.contains(evento.relatedTarget)) {
                zona.classList.remove('arrastrando');
            }
        });

        zona.addEventListener('drop', function (evento) {
            evento.preventDefault();
            zona.classList.remove('arrastrando');
            const archivos = evento.dataTransfer && evento.dataTransfer.files;
            if (!archivos || !archivos.length) return;

            const transferencia = new DataTransfer();
            transferencia.items.add(archivos[0]);
            input.files = transferencia.files;
            actualizarFormatosDestino();
        });
    }

    function inicializar() {
        porId('archivoConversion').addEventListener('change', actualizarFormatosDestino);
        configurarZonaArrastre();
        actualizarFormatosDestino();
    }

    window.actualizarFormatosDestino = actualizarFormatosDestino;
    window.convertirArchivo = convertirArchivo;
    window.cancelarConversion = cancelarConversion;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inicializar);
    } else {
        inicializar();
    }
})();
