import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OverlayPanel } from './overlay-panel';

describe('OverlayPanel', () => {
  let component: OverlayPanel;
  let fixture: ComponentFixture<OverlayPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OverlayPanel],
    }).compileComponents();

    fixture = TestBed.createComponent(OverlayPanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
