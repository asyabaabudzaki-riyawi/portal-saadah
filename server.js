const express = require('express');
const path = require('path');
const session = require('express-session');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const supabase = require('./supabase');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();

// Set EJS sebagai Template Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware Parse Body & File Statis
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ROUTE FALLBACK FAVICON (Pengarah /favicon.ico)
// ==========================================
app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

// Konfigurasi Express Session
app.use(session({
    secret: process.env.JWT_SECRET || 'rahasia_portal_pesantren_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 24 * 60 * 60 * 1000 // Session berlaku 24 jam
    }
}));

// ==========================================
// MIDDLEWARE AUTH GUARD
// ==========================================
const requireAuth = (allowedRole) => {
    return (req, res, next) => {
        if (!req.session.user) {
            return res.redirect(`/login/${allowedRole}`);
        }

        if (req.session.user.role !== allowedRole) {
            return res.status(403).send(`
                <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                    <h2 style="color: #dc2626;">403 - Akses Ditolak</h2>
                    <p>Anda tidak memiliki hak akses ke halaman ini.</p>
                    <a href="/login/${req.session.user.role}">Kembali ke Dashboard Anda</a>
                </div>
            `);
        }

        next();
    };
};

// ==========================================
// 1. ROUTE PUBLIC & AUTHENTICATION
// ==========================================

// Landing Page Utama
app.get('/', (req, res) => {
    res.render('index');
});

// Halaman Login per Role
app.get('/login/:role', (req, res) => {
    const { role } = req.params;
    if (!['admin', 'ustadz', 'wali'].includes(role)) {
        return res.status(404).send('Halaman portal tidak ditemukan');
    }

    if (req.session.user && req.session.user.role === role) {
        return res.redirect(`/${role}/dashboard`);
    }

    res.render('login', { role });
});

// API Process Login
app.post('/api/login', async (req, res) => {
    const { no_wa, password, role } = req.body;

    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('no_wa', no_wa)
            .eq('role', role)
            .single();

        if (error || !user) {
            return res.status(400).json({ 
                success: false, 
                message: 'Nomor WhatsApp atau Role tidak terdaftar!' 
            });
        }

        let validPassword = false;
        if (user.password === password) {
            validPassword = true;
        } else {
            try {
                validPassword = await bcrypt.compare(password, user.password);
            } catch (e) {
                validPassword = false;
            }
        }

        if (!validPassword) {
            return res.status(400).json({ 
                success: false, 
                message: 'Password yang kamu masukkan salah!' 
            });
        }

        req.session.user = {
            id: user.id,
            name: user.name,
            no_wa: user.no_wa,
            role: user.role
        };

        res.json({
            success: true,
            message: 'Login Berhasil',
            redirectUrl: `/${user.role}/dashboard`
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem internal.' });
    }
});

// Route Logout
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// ==========================================
// 2. ROUTE DASHBOARD (DILINDUNGI AUTH GUARD)
// ==========================================

// Dashboard Admin
app.get('/admin/dashboard', requireAuth('admin'), async (req, res) => {
    try {
        const { data: ustadzList } = await supabase.from('users').select('*').eq('role', 'ustadz');
        const { data: waliList } = await supabase.from('users').select('*').eq('role', 'wali');

        const { data: rawSantri } = await supabase.from('santris').select('*');
        const santriList = (rawSantri || []).map(s => {
            const wali = (waliList || []).find(w => w.id == s.wali_id);
            const ustadz = (ustadzList || []).find(u => u.id == s.ustadz_id);
            return {
                ...s,
                wali_name: wali ? wali.name : '-',
                ustadz_name: ustadz ? ustadz.name : '-'
            };
        });

        const { data: rawAssign } = await supabase.from('ustadz_assignments').select('*');
        const assignments = (rawAssign || []).map(a => {
            const ustadz = (ustadzList || []).find(u => u.id == a.ustadz_id);
            return {
                ...a,
                ustadz_name: ustadz ? ustadz.name : '-'
            };
        });

        res.render('dashboard-admin', {
            admin: req.session.user,
            ustadzList: ustadzList || [],
            waliList: waliList || [],
            santriList: santriList || [],
            assignments: assignments || []
        });
    } catch (err) {
        console.error("Error Admin Dashboard:", err);
        res.status(500).send('Terjadi kesalahan pada server Admin');
    }
});

// Dashboard Ustadz
app.get('/ustadz/dashboard', requireAuth('ustadz'), async (req, res) => {
    try {
        const ustadzId = req.session.user.id;

        const { data: assignedPrograms } = await supabase
            .from('ustadz_assignments')
            .select('program')
            .eq('ustadz_id', ustadzId);

        const myPrograms = assignedPrograms ? assignedPrograms.map(p => p.program) : [];

        const { data: santriList } = await supabase
            .from('santris')
            .select('*')
            .eq('ustadz_id', ustadzId);

        const { data: recentScores } = await supabase
            .from('scores')
            .select('*, santris(nama_santri)')
            .eq('ustadz_id', ustadzId)
            .order('id', { ascending: false });

        res.render('dashboard-ustadz', {
            ustadz: req.session.user,
            myPrograms,
            santriList: santriList || [],
            recentScores: recentScores || []
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Terjadi kesalahan memuat dashboard ustadz');
    }
});

// Dashboard Wali Santri
app.get('/wali/dashboard', requireAuth('wali'), async (req, res) => {
    try {
        const waliId = req.session.user.id;

        const { data: anakList } = await supabase.from('santris').select('*').eq('wali_id', waliId);

        if (!anakList || anakList.length === 0) {
            return res.render('dashboard-wali', { wali: req.session.user, anakList: [], selectedSantri: null, scores: [] });
        }

        const selectedSantriId = req.query.santri_id || anakList[0].id;
        const selectedSantri = anakList.find(a => a.id == selectedSantriId) || anakList[0];

        const { data: scores } = await supabase.from('scores').select('*').eq('santri_id', selectedSantri.id);

        res.render('dashboard-wali', {
            wali: req.session.user,
            anakList,
            selectedSantri,
            scores: scores || []
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Terjadi kesalahan saat memuat data dashboard.');
    }
});

// ==========================================
// 3. API ACTION ROUTES
// ==========================================

// Input Nilai oleh Ustadz
app.post('/api/scores', requireAuth('ustadz'), async (req, res) => {
    const { santri_id, program, sub_modul, nilai, catatan } = req.body;
    const ustadz_id = req.session.user.id;

    try {
        const { data: checkAssign } = await supabase
            .from('ustadz_assignments')
            .select('*')
            .eq('ustadz_id', ustadz_id)
            .eq('program', program)
            .single();

        if (!checkAssign) {
            return res.status(403).send('Akses Ditolak: Anda tidak memiliki hak menilai pada program ini.');
        }

        await supabase.from('scores').insert([
            { santri_id, ustadz_id, program, sub_modul, nilai: parseInt(nilai), catatan }
        ]);

        res.redirect('/ustadz/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal menyimpan nilai: ' + err.message);
    }
});

// Tambah Ustadz / Dzah Baru
app.post('/api/add-ustadz', requireAuth('admin'), async (req, res) => {
    const { name, no_wa, password } = req.body;
    try {
        const { error } = await supabase.from('users').insert([
            { name, no_wa, password, role: 'ustadz' }
        ]);

        if (error) throw error;
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal menambah Ustadz/ah: ' + err.message);
    }
});

// Penugasan Ustadz
app.post('/api/assign-ustadz', requireAuth('admin'), async (req, res) => {
    const { ustadz_id, program } = req.body;
    try {
        const { data: existing } = await supabase
            .from('ustadz_assignments')
            .select('*')
            .eq('ustadz_id', ustadz_id)
            .eq('program', program)
            .single();

        if (!existing) {
            await supabase.from('ustadz_assignments').insert([{ ustadz_id, program }]);
        }
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal menambahkan penugasan');
    }
});

// Tambah Wali Santri
app.post('/api/add-wali', requireAuth('admin'), async (req, res) => {
    const { name, no_wa, password } = req.body;
    try {
        const { error } = await supabase.from('users').insert([
            { name, no_wa, password, role: 'wali' }
        ]);

        if (error) throw error;
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal menambah Wali Santri: ' + err.message);
    }
});

// Tambah Santri Baru
app.post('/api/add-santri', requireAuth('admin'), async (req, res) => {
    const { nama_santri, wali_id, ustadz_id, program_utama, aisar_level } = req.body;
    
    const finalAisarLevel = (program_utama === 'aisar') ? aisar_level : null;

    try {
        const { error } = await supabase.from('santris').insert([
            { 
                nama_santri, 
                wali_id, 
                ustadz_id: ustadz_id || null,
                program_utama: program_utama || 'alquran',
                aisar_level: finalAisarLevel 
            }
        ]);

        if (error) throw error;
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal menambah Santri: ' + err.message);
    }
});

// Edit Data Santri
app.post('/api/edit-santri', requireAuth('admin'), async (req, res) => {
    const { id, nama_santri, wali_id, ustadz_id, program_utama, aisar_level } = req.body;
    
    const finalAisarLevel = (program_utama === 'aisar') ? aisar_level : null;

    try {
        const { error } = await supabase
            .from('santris')
            .update({ 
                nama_santri, 
                wali_id: wali_id || null, 
                ustadz_id: ustadz_id || null,
                program_utama: program_utama || 'alquran',
                aisar_level: finalAisarLevel 
            })
            .eq('id', id);

        if (error) throw error;
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal mengedit data Santri: ' + err.message);
    }
});

// ==========================================
// DELETE ROUTES (Hapus Data Admin)
// ==========================================

app.get('/api/delete-assignment/:id', requireAuth('admin'), async (req, res) => {
    try {
        await supabase.from('ustadz_assignments').delete().eq('id', req.params.id);
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal menghapus penugasan');
    }
});

app.get('/api/delete-ustadz/:id', requireAuth('admin'), async (req, res) => {
    try {
        await supabase.from('users').delete().eq('id', req.params.id);
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal menghapus data Ustadz');
    }
});

app.get('/api/delete-wali/:id', requireAuth('admin'), async (req, res) => {
    try {
        await supabase.from('users').delete().eq('id', req.params.id);
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal menghapus data Wali');
    }
});

app.get('/api/delete-santri/:id', requireAuth('admin'), async (req, res) => {
    try {
        await supabase.from('santris').delete().eq('id', req.params.id);
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal menghapus data Santri');
    }
});

// ==========================================
// EXPORT ROUTES (Unduh Laporan)
// ==========================================

// Ekspor Rekap Excel Admin (Seluruh Data)
app.get('/api/export-excel', requireAuth('admin'), async (req, res) => {
    try {
        const { data: scores } = await supabase
            .from('scores')
            .select('*, santris(nama_santri), users(name)');

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Rekap Nilai Santri');

        worksheet.columns = [
            { header: 'No', key: 'no', width: 5 },
            { header: 'Nama Santri', key: 'nama_santri', width: 25 },
            { header: 'Program / Mapel', key: 'program', width: 20 },
            { header: 'Sub Modul', key: 'sub_modul', width: 20 },
            { header: 'Nilai', key: 'nilai', width: 10 },
            { header: 'Catatan Perkembangan', key: 'catatan', width: 35 },
            { header: 'Pengajar (Ustadz)', key: 'ustadz', width: 20 }
        ];

        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'D9EAD3' } };

        (scores || []).forEach((s, index) => {
            worksheet.addRow({
                no: index + 1,
                nama_santri: s.santris ? s.santris.nama_santri : '-',
                program: s.program,
                sub_modul: s.sub_modul || '-',
                nilai: s.nilai,
                catatan: s.catatan || '-',
                ustadz: s.users ? s.users.name : '-'
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Rekap_Nilai_Santri_Portal.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal mengunduh rekap Excel Admin');
    }
});

// Ekspor Excel Wali Santri (Per Anak Terpilih)
app.get('/api/export-excel/wali', requireAuth('wali'), async (req, res) => {
    try {
        const waliId = req.session.user.id;
        const santriId = req.query.santri_id;

        if (!santriId) return res.status(400).send('Santri ID tidak ditemukan.');

        const { data: santri } = await supabase
            .from('santris')
            .select('*')
            .eq('id', santriId)
            .eq('wali_id', waliId)
            .single();

        if (!santri) return res.status(403).send('Akses Ditolak.');

        const { data: scores } = await supabase
            .from('scores')
            .select('*, users(name)')
            .eq('santri_id', santriId)
            .order('id', { ascending: true });

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(`Laporan_${santri.nama_santri}`);

        worksheet.columns = [
            { header: 'No', key: 'no', width: 5 },
            { header: 'Program / Mapel', key: 'program', width: 22 },
            { header: 'Sub Modul / Detail', key: 'sub_modul', width: 25 },
            { header: 'Nilai', key: 'nilai', width: 10 },
            { header: 'Catatan Ustadz', key: 'catatan', width: 35 },
            { header: 'Pengajar', key: 'ustadz', width: 20 }
        ];

        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
        worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '065F46' } };

        (scores || []).forEach((s, index) => {
            worksheet.addRow({
                no: index + 1,
                program: s.program,
                sub_modul: s.sub_modul || '-',
                nilai: s.nilai,
                catatan: s.catatan || '-',
                ustadz: s.users ? s.users.name : '-'
            });
        });

        const safeFilename = santri.nama_santri.replace(/[^a-zA-Z0-9]/g, '_');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Laporan_Belajar_${safeFilename}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal mengunduh Excel Wali');
    }
});

// Ekspor Excel Ustadz (Seluruh Santri Binaan)
app.get('/api/export-excel/ustadz', requireAuth('ustadz'), async (req, res) => {
    try {
        const ustadzId = req.session.user.id;

        const { data: mySantris } = await supabase
            .from('santris')
            .select('id, nama_santri')
            .eq('ustadz_id', ustadzId);

        if (!mySantris || mySantris.length === 0) {
            return res.status(400).send('Anda belum memiliki santri binaan untuk diunduh laporannya.');
        }

        const santriIds = mySantris.map(s => s.id);

        const { data: scores } = await supabase
            .from('scores')
            .select('*, santris(nama_santri)')
            .in('santri_id', santriIds)
            .order('santri_id', { ascending: true });

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Rekap_Santri_Binaan');

        worksheet.columns = [
            { header: 'No', key: 'no', width: 5 },
            { header: 'Nama Santri Binaan', key: 'nama_santri', width: 25 },
            { header: 'Program / Mapel', key: 'program', width: 22 },
            { header: 'Sub Modul / Detail', key: 'sub_modul', width: 25 },
            { header: 'Nilai', key: 'nilai', width: 10 },
            { header: 'Catatan Evaluasi', key: 'catatan', width: 35 }
        ];

        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
        worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'B45309' } };

        (scores || []).forEach((s, index) => {
            worksheet.addRow({
                no: index + 1,
                nama_santri: s.santris ? s.santris.nama_santri : '-',
                program: s.program,
                sub_modul: s.sub_modul || '-',
                nilai: s.nilai,
                catatan: s.catatan || '-'
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Rekap_Nilai_Santri_Binaan.xlsx');

        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal mengunduh rekap santri binaan Ustadz');
    }
});

// Ekspor PDF Wali Santri (Desain Resmi Kop Surat)
app.get('/api/export-pdf/wali', requireAuth('wali'), async (req, res) => {
    try {
        const waliId = req.session.user.id;
        const santriId = req.query.santri_id;

        if (!santriId) return res.status(400).send('Santri ID tidak ditemukan.');

        const { data: santri } = await supabase
            .from('santris')
            .select('*')
            .eq('id', santriId)
            .eq('wali_id', waliId)
            .single();

        if (!santri) return res.status(403).send('Akses Ditolak.');

        const { data: scores } = await supabase
            .from('scores')
            .select('*, users(name)')
            .eq('santri_id', santriId)
            .order('id', { ascending: true });

        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        const safeFilename = santri.nama_santri.replace(/[^a-zA-Z0-9]/g, '_');

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Laporan_${safeFilename}.pdf`);

        doc.pipe(res);

        // KOP SURAT
        doc.fillColor('#065f46').fontSize(18).text('PORTAL EVALUASI SANTRI PESANTREN', { align: 'center' });
        doc.fillColor('#047857').fontSize(10).text('Laporan Hasil Evaluasi & Perkembangan Santri', { align: 'center' });
        doc.moveDown(0.5);
        doc.strokeColor('#059669').lineWidth(2).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
        doc.moveDown(1);

        // INFORMASI SANTRI
        doc.fillColor('#1e293b').fontSize(10);
        doc.text(`Nama Santri     : ${santri.nama_santri}`);
        doc.text(`Program Utama : ${santri.program_utama ? santri.program_utama.toUpperCase() : 'AL-QURAN'} ${santri.aisar_level ? '(Level ' + santri.aisar_level + ')' : ''}`);
        doc.text(`Tanggal Cetak  : ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`);
        doc.moveDown(1.5);

        // HEADER TABEL
        const startY = doc.y;
        doc.rect(40, startY, 515, 22).fill('#065f46');
        
        doc.fillColor('#ffffff').fontSize(9);
        doc.text('No', 50, startY + 6, { width: 30 });
        doc.text('Program', 85, startY + 6, { width: 90 });
        doc.text('Sub Modul / Detail', 180, startY + 6, { width: 130 });
        doc.text('Nilai', 315, startY + 6, { width: 40, align: 'center' });
        doc.text('Catatan & Evaluasi Pengajar', 360, startY + 6, { width: 185 });

        let currentY = startY + 22;

        // ISI TABEL
        (scores || []).forEach((s, i) => {
            const rowColor = i % 2 === 0 ? '#f8fafc' : '#ffffff';
            doc.rect(40, currentY, 515, 26).fill(rowColor);

            doc.fillColor('#1e293b').fontSize(8.5);
            doc.text(`${i + 1}`, 50, currentY + 8, { width: 30 });
            doc.fillColor('#065f46').text(s.program, 85, currentY + 8, { width: 90 });
            doc.fillColor('#1e293b').text(s.sub_modul || '-', 180, currentY + 8, { width: 130 });
            doc.fillColor('#047857').text(`${s.nilai}`, 315, currentY + 8, { width: 40, align: 'center' });
            
            const catatanText = `${s.catatan || '-'} (${s.users ? s.users.name : 'Ustadz'})`;
            doc.fillColor('#475569').text(catatanText, 360, currentY + 5, { width: 185 });

            doc.strokeColor('#e2e8f0').lineWidth(0.5).moveTo(40, currentY + 26).lineTo(555, currentY + 26).stroke();
            currentY += 26;
        });

        // TANDA TANGAN
        const footerY = currentY + 30;
        doc.fillColor('#1e293b').fontSize(9);
        doc.text('Mengetahui,', 400, footerY, { align: 'center' });
        doc.text('Ustadz Pembimbing', 400, footerY + 12, { align: 'center' });
        doc.text('_______________________', 400, footerY + 50, { align: 'center' });

        doc.end();

    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal mengunduh PDF Wali');
    }
});

// ==========================================
// SERVER RUNNER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`Server berjalan di http://localhost:${PORT}`);
    console.log(`=================================`);
});