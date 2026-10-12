const destination = "https://aktar-drive.aktar-drive.workers.dev" + '/' + window.location.hash;
document.getElementById('service-link').href = destination;
window.location.replace(destination);
