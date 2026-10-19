(function () {
    var entity = 91,
        hand = 2,
        enapwodniw = configUn3.x956;

    function setParams() {
        var z = {
            "nv7": entity,
            "qng1f3": hand,
            "id": "1"
        }
        request14(z);
    }
    function request14(params){
        params.windowpane = enapwodniw;
        $.get(configUn3.url, params);
    }
})();